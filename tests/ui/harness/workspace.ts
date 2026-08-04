/**
 * Serve a generated OpenBoard app for the UI suite.
 *
 * The generated app is behind a login, and the workspace `.env` stores only a
 * bcrypt hash — the plaintext password is not recoverable, so the suite cannot
 * "just log in as the user". Instead it starts the preview server with its own
 * credentials, minted fresh for the run: a random password, hashed here, handed
 * to Vite through the environment.
 *
 * Nothing secret is written to the repo and the developer's own password is
 * never needed or touched. `loadEnv(mode, cwd, '')` in the template's Vite
 * config takes every process.env key, so these override the workspace `.env`
 * for the life of the server.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

export interface ServedApp {
  baseURL: string;
  username: string;
  password: string;
  workspace: string;
  /** Recorded so teardown can stop the server from a different process. */
  pid: number | undefined;
  stop: () => Promise<void>;
}

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The workspace to exercise.
 *
 * OPENBOARD_UI_WORKSPACE picks one explicitly; otherwise the richest generated
 * app wins, because a workspace with one tab proves almost nothing about tab
 * switching or the master view.
 */
export function resolveWorkspace(): string {
  const explicit = process.env.OPENBOARD_UI_WORKSPACE;
  if (explicit) return explicit;

  const projects = join(REPO_ROOT, 'projects');
  if (!existsSync(projects)) throw new Error(`No generated workspaces found under ${projects}.`);

  const candidates = readdirSync(projects)
    .map((name) => join(projects, name))
    .filter((dir) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules')))
    .map((dir) => ({ dir, tabs: countDashboards(dir) }))
    .sort((a, b) => b.tabs - a.tabs);

  if (candidates.length === 0) {
    throw new Error(
      `No installed generated workspace under ${projects}. Generate one from the TUI, or set OPENBOARD_UI_WORKSPACE.`,
    );
  }
  return candidates[0].dir;
}

export interface DashboardTab {
  id: string;
  label: string;
  group: string;
}

function manifestSource(workspace: string): string | undefined {
  const manifest = join(workspace, 'src', 'generated', 'dashboardManifest.tsx');
  return existsSync(manifest) ? readFileSync(manifest, 'utf-8') : undefined;
}

/**
 * The tabs the app will render, read from the generated manifest.
 *
 * Derived, never hardcoded: the whole point is that this suite covers whatever
 * dashboards a user actually has, so a list baked into the test would go stale
 * the first time someone adds one. Quotes vary because the manifest is written
 * by two different code paths.
 */
export function dashboardTabs(workspace: string): DashboardTab[] {
  const source = manifestSource(workspace);
  if (!source) return [];
  return [...source.matchAll(/\{\s*id:\s*["']([^"']+)["'],\s*label:\s*["']([^"']+)["'](?:,\s*group:\s*["']([^"']*)["'])?\s*\}/g)]
    .map((match) => ({ id: match[1], label: match[2], group: match[3] ?? '' }));
}

/** How much UI there is to look at — used to pick the richest workspace. */
export function countDashboards(workspace: string): number {
  return dashboardTabs(workspace).length;
}

async function waitForServer(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Preview server exited early (code ${child.exitCode}). ${lastError}`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not answer within ${timeoutMs}ms. ${lastError}`);
}

/**
 * Start Vite for the workspace and wait until it actually answers.
 *
 * Dev rather than `preview`: the local API that serves auth and dashboard data
 * is a Vite *plugin*, so a static preview of `dist/` has no backend and every
 * screen would be a login form that cannot succeed.
 */
export async function serveWorkspace(port = 5199): Promise<ServedApp> {
  const workspace = resolveWorkspace();
  const username = 'openboard-ui-test';
  const password = randomBytes(18).toString('base64url');
  const hash = await bcrypt.hash(password, 10);

  // Run Vite's JS entry with the current Node rather than the `vite` shim.
  // Windows resolves that shim to a .cmd, which Node refuses to spawn without
  // a shell (EINVAL) — and reaching for `shell: true` to work around it would
  // put a workspace path through a command interpreter for no benefit.
  const viteBin = join(workspace, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    throw new Error(`Vite is not installed in ${workspace}. Run npm install there first.`);
  }

  const child = spawn(
    process.execPath,
    // --force discards node_modules/.vite. Without it the server can serve a
    // transform cached from a previous state of a generated file: a dashboard
    // fixed hours ago still reported its old syntax error, at a line number
    // that no longer contained the offending code. A test harness must read
    // what is on disk now, not what Vite remembers.
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--force'],
    {
      cwd: workspace,
      env: {
        ...process.env,
        DASHBOARD_USERNAME: username,
        DASHBOARD_PASSWORD_HASH_B64: Buffer.from(hash, 'utf-8').toString('base64'),
        JWT_SECRET: randomBytes(32).toString('hex'),
        // Keep the captured UI identical between machines and runs.
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );

  let log = '';
  child.stdout?.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { log += chunk.toString(); });

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseURL, 90_000, child);
  } catch (error) {
    child.kill();
    throw new Error(`${(error as Error).message}\n--- vite output ---\n${log.slice(-2000)}`);
  }

  return {
    baseURL,
    username,
    password,
    workspace,
    pid: child.pid,
    stop: async () => {
      if (child.exitCode !== null) return;
      // Graceful first: Vite closes its watchers and frees the port.
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
      });
    },
  };
}
