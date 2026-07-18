import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

type LocalEnvironment = Record<string, string>

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return undefined
}

function passwordHash(env: LocalEnvironment): string | undefined {
  if (env.DASHBOARD_PASSWORD_HASH_B64) {
    try {
      return Buffer.from(env.DASHBOARD_PASSWORD_HASH_B64, 'base64').toString('utf-8')
    } catch {
      return undefined
    }
  }
  return env.DASHBOARD_PASSWORD_HASH
}

function authenticated(req: IncomingMessage, env: LocalEnvironment): { username: string } | null {
  const token = cookie(req, 'auth_token')
  if (!token || !env.JWT_SECRET) return null
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { username?: string }
    return payload.username ? { username: payload.username } : null
  } catch {
    return null
  }
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, env: LocalEnvironment): Promise<void> {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
    send(res, 200, { success: true })
    return
  }

  if (req.method === 'GET') {
    const user = authenticated(req, env)
    send(res, user ? 200 : 401, user ? { authenticated: true, username: user.username } : { authenticated: false })
    return
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' })
    return
  }

  const body = await readJson(req)
  const username = typeof body.username === 'string' ? body.username : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const hash = passwordHash(env)
  if (!env.DASHBOARD_USERNAME || !hash || !env.JWT_SECRET) {
    send(res, 500, { error: 'Local preview credentials are not configured. Restart preview from OpenBoard.' })
    return
  }

  if (username !== env.DASHBOARD_USERNAME || !(await bcrypt.compare(password, hash))) {
    send(res, 401, { error: 'Invalid credentials' })
    return
  }

  const token = jwt.sign({ username }, env.JWT_SECRET, { expiresIn: '7d' })
  const maxAge = 7 * 24 * 60 * 60
  // Local preview is HTTP, so Secure must be omitted or browsers discard the cookie.
  res.setHeader('Set-Cookie', `auth_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`)
  send(res, 200, { success: true, username })
}

async function handleDashboardData(
  req: IncomingMessage,
  res: ServerResponse,
  env: LocalEnvironment,
  server: ViteDevServer,
): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' })
    return
  }
  if (!authenticated(req, env)) {
    send(res, 401, { authenticated: false, error: 'Authentication required' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const dashboard = url.searchParams.get('dashboard')?.trim() ?? ''
  if (!dashboard) {
    send(res, 400, { error: 'Missing dashboard query parameter' })
    return
  }

  const module = await server.ssrLoadModule('/api/_data/protected-data.ts')
  const dashboards = (module.PROTECTED_DASHBOARD_DATA ?? {}) as Record<string, unknown>
  res.setHeader('Cache-Control', 'private, no-store')
  if (dashboard === '__all__') {
    send(res, 200, { dashboards, generatedAt: new Date().toISOString() })
    return
  }
  if (!/^[a-z0-9-]+$/.test(dashboard)) {
    send(res, 400, { error: 'Invalid dashboard name' })
    return
  }
  if (!(dashboard in dashboards)) {
    send(res, 404, { error: 'Dashboard data not found' })
    return
  }
  send(res, 200, dashboards[dashboard])
}

/** Serves the Vercel API routes while running the dashboard with plain Vite. */
export function localApiPlugin(env: LocalEnvironment): Plugin {
  return {
    name: 'openboard-local-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
          if (pathname === '/api/auth') return await handleAuth(req, res, env)
          if (pathname === '/api/dashboard-data') return await handleDashboardData(req, res, env, server)
          next()
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : 'Local API error' })
        }
      })
    },
  }
}
