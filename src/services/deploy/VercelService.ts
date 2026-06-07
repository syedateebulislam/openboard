import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossSpawn, resolveSpawnInvocation } from '../../utils/crossSpawn.js';
import { ConfigService } from '../config/ConfigService.js';
import type { ProgressCallback } from '../build/BuildService.js';

export interface VercelResult {
  success: boolean;
  error?: string;
  url?: string;
  deploymentId?: string;
}

interface VercelProjectApiResponse {
  id?: string;
  name?: string;
  accountId?: string;
  error?: {
    code?: string;
    message?: string;
    scope?: string;
    teamId?: string | null;
  };
}

function runVercelCommand(
  args: string[],
  cwd: string,
  timeoutMs = 180_000,
  onProgress?: ProgressCallback,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return crossSpawn('vercel', withVercelAuthArgs(args), {
    cwd,
    timeoutMs,
    onProgress,
    env: getVercelEnv(),
  });
}

function getSavedVercelToken(): string | undefined {
  try {
    const config = new ConfigService();
    return normalizeVercelToken(config.getSecret('vercel.token')) ?? getVercelTokenFromEnv();
  } catch {
    return getVercelTokenFromEnv();
  }
}

function getVercelTokenFromEnv(): string | undefined {
  return normalizeVercelToken(process.env.OPENBOARD_VERCEL_TOKEN ?? process.env.VERCEL_TOKEN);
}

function getVercelEnv(): Record<string, string | undefined> | undefined {
  const token = getSavedVercelToken();
  if (token) return { VERCEL_TOKEN: token };
  if (hasUnreadableEncryptedVercelToken()) return { VERCEL_TOKEN: undefined };
  return undefined;
}

function getVercelAuthArgs(): string[] | undefined {
  const token = getSavedVercelToken();
  return token ? ['--token', token] : undefined;
}

function withVercelAuthArgs(args: string[]): string[] {
  const authArgs = getVercelAuthArgs();
  return authArgs ? [...args, ...authArgs] : args;
}

function getVercelTeamId(): string | undefined {
  try {
    const teamId = new ConfigService().get('vercel.teamId');
    return typeof teamId === 'string' && teamId.trim() ? teamId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function getVercelTeamArgs(): string[] {
  const teamId = getVercelTeamId();
  return teamId ? ['--team', teamId] : [];
}

function sanitizeVercelProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function getVercelProjectName(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string') {
      const name = sanitizeVercelProjectName(pkg.name);
      if (name) return name;
    }
  } catch {
    // Fall back to directory name below.
  }

  const fallback = sanitizeVercelProjectName(projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'openboard-workspace');
  return fallback || 'openboard-workspace';
}

function getVercelLinkArgs(projectDir: string): string[] {
  return ['link', '--yes', '--project', getVercelProjectName(projectDir), ...getVercelTeamArgs()];
}

function getVercelApiUrl(path: string): string {
  const teamId = getVercelTeamId();
  const url = new URL(path, 'https://api.vercel.com');
  if (teamId) url.searchParams.set('teamId', teamId);
  return url.toString();
}

function formatVercelApiError(action: string, body: VercelProjectApiResponse, status: number): string {
  const message = body.error?.message ?? `Vercel API returned HTTP ${status}`;
  const scope = body.error?.scope ? ` Scope: ${body.error.scope}.` : '';
  return `${action} failed. ${message}${scope}`;
}

async function requestVercelProject(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: VercelProjectApiResponse }> {
  const token = getSavedVercelToken();
  if (!token) return { status: 401, body: { error: { message: 'No Vercel token configured.' } } };

  const response = await fetch(getVercelApiUrl(path), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: VercelProjectApiResponse = {};
  if (text) {
    try {
      body = JSON.parse(text) as VercelProjectApiResponse;
    } catch {
      body = { error: { message: text.slice(0, 300) } };
    }
  }
  return { status: response.status, body };
}

function writeLocalVercelProject(projectDir: string, project: VercelProjectApiResponse): VercelResult {
  if (!project.id || !project.accountId) {
    return {
      success: false,
      error: 'Vercel project link failed. Project API response did not include project id and account id.',
    };
  }

  const vercelDir = join(projectDir, '.vercel');
  mkdirSync(vercelDir, { recursive: true });
  writeFileSync(
    join(vercelDir, 'project.json'),
    JSON.stringify({ orgId: project.accountId, projectId: project.id }, null, 2) + '\n',
    'utf-8',
  );
  return { success: true };
}

async function linkViaVercelApi(projectDir: string): Promise<VercelResult> {
  const projectName = getVercelProjectName(projectDir);
  const existing = await requestVercelProject(`/v9/projects/${encodeURIComponent(projectName)}`, {
    method: 'GET',
  });

  if (existing.status === 200) {
    return writeLocalVercelProject(projectDir, existing.body);
  }

  if (existing.status !== 404) {
    return {
      success: false,
      error: normalizeAuthError(formatVercelApiError('Vercel project lookup', existing.body, existing.status)),
    };
  }

  const created = await requestVercelProject('/v9/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      framework: 'vite',
    }),
  });

  if (created.status < 200 || created.status >= 300) {
    return {
      success: false,
      error: normalizeAuthError(formatVercelApiError('Vercel project creation', created.body, created.status)),
    };
  }

  return writeLocalVercelProject(projectDir, created.body);
}

function normalizeVercelToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  if (!token) return undefined;
  if (token.startsWith('enc:')) return undefined;
  if (/[\s:]/.test(token)) return undefined;
  return token;
}

function hasUnreadableEncryptedVercelToken(): boolean {
  try {
    const raw = new ConfigService().getRaw('vercel.token');
    return typeof raw === 'string' && raw.startsWith('enc:') && !getSavedVercelToken();
  } catch {
    return false;
  }
}

function warnUnreadableToken(onProgress?: ProgressCallback): void {
  if (hasUnreadableEncryptedVercelToken()) {
    onProgress?.('Saved Vercel token cannot be decrypted. Falling back to existing Vercel CLI login.');
    onProgress?.('   To use token auth again, re-enter the Vercel token in setup/settings.');
  }
}

function normalizeAuthError(error: string): string {
  const text = error.trim();
  if (
    /specified token is not valid/i.test(text) ||
    /invalid token/i.test(text) ||
    /no existing credentials/i.test(text) ||
    /vercel login/i.test(text) ||
    /not authorized/i.test(text) ||
    /token with access to this scope/i.test(text)
  ) {
    return [
      'Vercel is not authenticated.',
      'Re-enter the Vercel token in OpenBoard Settings with access to the personal/team scope for this project, or run `vercel login` manually.',
      text,
    ].join('\n');
  }
  return text;
}

function isStaleProjectLinkError(error: string): boolean {
  return (
    /could not retrieve project settings/i.test(error) ||
    /cannot-load-project-settings/i.test(error) ||
    /remove the [`']?\.vercel[`']? directory/i.test(error)
  );
}

function removeLocalVercelLink(projectDir: string): void {
  const vercelDir = join(projectDir, '.vercel');
  if (!existsSync(vercelDir)) return;
  rmSync(vercelDir, { recursive: true, force: true });
}

function extractVercelUrl(output: string): string | undefined {
  const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/);
  return urlMatch ? urlMatch[0].replace(/[)\],.]+$/, '') : undefined;
}

function getVercelProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const token = getSavedVercelToken();
  if (token) {
    env.VERCEL_TOKEN = token;
  } else if (hasUnreadableEncryptedVercelToken()) {
    delete env.VERCEL_TOKEN;
  }
  return env;
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+$-]+$/.test(value)) {
    return value;
  }
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')}"`;
}

export class VercelService {
  static async validateTokenForProjectAccess(token: string): Promise<VercelResult> {
    const normalized = normalizeVercelToken(token);
    if (!normalized) {
      return { success: false, error: 'Invalid Vercel token format.' };
    }

    try {
      const userResponse = await fetch('https://api.vercel.com/v2/user', {
        headers: { authorization: `Bearer ${normalized}` },
      });
      if (!userResponse.ok) {
        const text = await userResponse.text().catch(() => '');
        return { success: false, error: normalizeAuthError(text || `Vercel user validation failed with HTTP ${userResponse.status}`) };
      }

      const projectsResponse = await fetch('https://api.vercel.com/v9/projects', {
        headers: { authorization: `Bearer ${normalized}` },
      });
      if (!projectsResponse.ok) {
        const text = await projectsResponse.text().catch(() => '');
        let body: VercelProjectApiResponse = {};
        try {
          body = text ? JSON.parse(text) as VercelProjectApiResponse : {};
        } catch {
          body = { error: { message: text.slice(0, 300) } };
        }
        return {
          success: false,
          error: normalizeAuthError(formatVercelApiError('Vercel project access validation', body, projectsResponse.status)),
        };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: `Could not validate Vercel token: ${error.message}` };
    }
  }

  static async checkVercelInstalled(): Promise<boolean> {
    try {
      const { code } = await crossSpawn('vercel', ['--version'], {
        cwd: process.cwd(),
        timeoutMs: 5000,
        env: hasUnreadableEncryptedVercelToken() ? { VERCEL_TOKEN: undefined } : undefined,
      });
      return code === 0;
    } catch {
      return false;
    }
  }

  static async checkAuthenticated(projectDir: string, onProgress?: ProgressCallback): Promise<VercelResult> {
    try {
      warnUnreadableToken(onProgress);
      const { code, stderr, stdout } = await runVercelCommand(['whoami'], projectDir, 30_000);
      if (code !== 0) {
        return { success: false, error: normalizeAuthError(stderr || stdout) };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: normalizeAuthError(error.message) };
    }
  }

  static async isVercelProject(projectDir: string): Promise<boolean> {
    return existsSync(join(projectDir, '.vercel'));
  }

  static async link(projectDir: string, onProgress?: ProgressCallback): Promise<VercelResult> {
    if (getSavedVercelToken()) {
      try {
        const result = await linkViaVercelApi(projectDir);
        if (result.success) {
          onProgress?.(`Linked project to Vercel: ${getVercelProjectName(projectDir)}`);
        }
        return result;
      } catch (error: any) {
        return { success: false, error: normalizeAuthError(error.message) };
      }
    }

    try {
      const { code, stderr, stdout } = await runVercelCommand(
        getVercelLinkArgs(projectDir),
        projectDir,
        60_000,
        onProgress,
      );

      if (code !== 0) {
        return { success: false, error: normalizeAuthError(stderr || stdout) };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Ensure the project is linked to Vercel. Links if not already linked.
   */
  static async ensureLinked(projectDir: string, onProgress?: ProgressCallback): Promise<VercelResult> {
    if (existsSync(join(projectDir, '.vercel'))) {
      return { success: true };
    }

    const isInstalled = await VercelService.checkVercelInstalled();
    if (!isInstalled) {
      return { success: false, error: 'Vercel CLI is not installed. Run: npm install -g vercel' };
    }
    warnUnreadableToken(onProgress);

    onProgress?.('Linking project to Vercel...');
    return VercelService.link(projectDir, onProgress);
  }

  static async deploy(
    projectDir: string,
    production = false,
    onProgress?: ProgressCallback,
  ): Promise<VercelResult> {
    try {
      const isInstalled = await VercelService.checkVercelInstalled();
      if (!isInstalled) {
        return {
          success: false,
          error: 'Vercel CLI is not installed. Run: npm install -g vercel',
        };
      }
      warnUnreadableToken(onProgress);

      const args = ['--yes'];
      if (production) {
        args.push('--prod');
      }

      const { code, stderr, stdout } = await runVercelCommand(args, projectDir, 180_000, onProgress);

      if (code !== 0) {
        const error = stderr || stdout;
        if (isStaleProjectLinkError(error)) {
          onProgress?.('Vercel project link is stale. Re-linking project and retrying deploy...');
          removeLocalVercelLink(projectDir);

          const linked = await VercelService.ensureLinked(projectDir, onProgress);
          if (!linked.success) {
            return { success: false, error: `Vercel relink failed: ${linked.error}` };
          }

          const retry = await runVercelCommand(args, projectDir, 180_000, onProgress);
          if (retry.code !== 0) {
            return { success: false, error: normalizeAuthError(retry.stderr || retry.stdout) };
          }

          const retryUrl = extractVercelUrl(`${retry.stdout}\n${retry.stderr}`);
          return { success: true, url: retryUrl };
        }

        return { success: false, error: normalizeAuthError(error) };
      }

      // Vercel CLI may write status and URLs to stderr depending on version.
      const url = extractVercelUrl(`${stdout}\n${stderr}`);

      return { success: true, url };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async deployProduction(projectDir: string, onProgress?: ProgressCallback): Promise<VercelResult> {
    return VercelService.deploy(projectDir, true, onProgress);
  }

  static async deployPreview(projectDir: string, onProgress?: ProgressCallback): Promise<VercelResult> {
    return VercelService.deploy(projectDir, false, onProgress);
  }

  static async getProjectInfo(projectDir: string): Promise<{
    name?: string;
    url?: string;
  } | null> {
    try {
      const vercelJsonPath = join(projectDir, '.vercel', 'project.json');
      if (!existsSync(vercelJsonPath)) return null;

      const content = readFileSync(vercelJsonPath, 'utf-8');
      const data = JSON.parse(content);

      return {
        name: data.name,
        url: data.url,
      };
    } catch {
      return null;
    }
  }

  /**
   * Write a .env file with dashboard credentials for local preview and Vercel deployment.
   */
  static writeEnvFile(projectDir: string, envVars: Record<string, string>): void {
    const envPath = join(projectDir, '.env');
    const lines = Object.entries(envVars)
      .map(([key, value]) => `${key}=${serializeEnvValue(value)}`)
      .join('\n');
    writeFileSync(envPath, lines + '\n', 'utf-8');
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // chmod is best-effort on Windows and some restricted filesystems.
    }
  }

  /**
   * Set environment variables on the Vercel project using `vercel env add`.
   * Pipes the value to stdin since `vercel env add` reads from stdin.
   */
  static async setEnvVar(
    projectDir: string,
    key: string,
    value: string,
    environments: string[] = ['production', 'preview', 'development'],
    onProgress?: ProgressCallback,
  ): Promise<boolean> {
    const { spawn } = await import('node:child_process');

    for (const env of environments) {
      // Remove existing value first (ignore errors if it doesn't exist)
      await crossSpawn('vercel', withVercelAuthArgs(['env', 'rm', key, env, '--yes']), {
        cwd: projectDir,
        timeoutMs: 15_000,
        env: getVercelEnv(),
      }).catch(() => {});

      // Add new value via stdin
      const ok = await new Promise<boolean>((resolve) => {
        const invocation = resolveSpawnInvocation('vercel', withVercelAuthArgs(['env', 'add', key, env]));
        const proc = spawn(invocation.command, invocation.args, {
          cwd: projectDir,
          shell: invocation.useShell,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: getVercelProcessEnv(),
        });

        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
        proc.stdin?.write(value);
        proc.stdin?.end();
      });

      if (!ok) {
        onProgress?.(`Failed to set ${key} for ${env}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Inject dashboard credentials as Vercel environment variables.
   */
  static async injectCredentials(
    projectDir: string,
    credentials: { username: string; passwordHash: string; jwtSecret: string },
    onProgress?: ProgressCallback,
  ): Promise<boolean> {
    onProgress?.('Setting dashboard credentials...');

    // Write .env for local use
    VercelService.writeEnvFile(projectDir, {
      DASHBOARD_USERNAME: credentials.username,
      DASHBOARD_PASSWORD_HASH: credentials.passwordHash,
      JWT_SECRET: credentials.jwtSecret,
    });

    // Also set on Vercel project if it's linked
    if (existsSync(join(projectDir, '.vercel'))) {
      const auth = await VercelService.checkAuthenticated(projectDir);
      if (!auth.success) {
        onProgress?.('Skipping Vercel env vars because Vercel is not authenticated.');
        onProgress?.(`   ${auth.error?.split('\n')[0] ?? 'Re-enter the Vercel token in setup/settings.'}`);
        return true;
      }

      const envVars: [string, string][] = [
        ['DASHBOARD_USERNAME', credentials.username],
        ['DASHBOARD_PASSWORD_HASH', credentials.passwordHash],
        ['JWT_SECRET', credentials.jwtSecret],
      ];

      let allSet = true;
      for (const [key, value] of envVars) {
        const ok = await VercelService.setEnvVar(projectDir, key, value, ['production', 'preview', 'development'], onProgress);
        if (!ok) {
          allSet = false;
          onProgress?.(`Could not set Vercel env var ${key}. Auth may not work on deployed dashboard.`);
        }
      }
      if (allSet) {
        onProgress?.('Credentials set on Vercel');
      } else {
        onProgress?.('Some Vercel credential env vars were not set.');
      }
    } else {
      onProgress?.('Wrote .env file (Vercel env vars will be set after first deploy)');
    }

    return true;
  }

  static async listDeployments(projectDir: string): Promise<VercelResult> {
    try {
      const { code, stderr, stdout } = await runVercelCommand(
        ['ls'],
        projectDir,
        30_000,
      );

      if (code !== 0) {
        return { success: false, error: stderr || stdout };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
