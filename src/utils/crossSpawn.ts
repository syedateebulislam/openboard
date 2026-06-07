/**
 * crossSpawn — Cross-platform process spawning utility.
 *
 * Detects the current OS and applies the correct shell/spawn strategy:
 * - Uses shell: false by default so args are never re-parsed by a shell.
 * - Windows: resolves common .cmd shims explicitly (npm.cmd, npx.cmd, etc.).
 *
 * For commands where arguments contain special characters (like git commit -m),
 * shell: false is used on ALL platforms to prevent arg splitting.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CrossSpawnOptions {
  cwd: string;
  /** Override shell behavior. Default: true on Windows, false elsewhere */
  useShell?: boolean;
  /** Timeout in milliseconds. Default: 120_000 (2 min) */
  timeoutMs?: number;
  /** Additional env vars merged with process.env. Use undefined to delete inherited vars. */
  env?: Record<string, string | undefined>;
  /** Called for each line of stdout/stderr output */
  onProgress?: (line: string) => void;
  /** If true, the process runs detached. Default: false */
  detached?: boolean;
}

/**
 * Get the default shell setting for the current platform.
 * Shell execution is opt-in. Defaulting to false keeps argv boundaries intact.
 */
function defaultShell(): boolean {
  return false;
}

const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'vercel', 'gh', 'codex', 'openclaw']);

export interface SpawnInvocation {
  command: string;
  args: string[];
  useShell: boolean;
}

export function resolveSpawnCommand(
  cmd: string,
  useShell = defaultShell(),
  isWindows = IS_WINDOWS,
): string {
  if (!isWindows || useShell) return cmd;
  const lower = cmd.toLowerCase();
  if (WINDOWS_CMD_SHIMS.has(lower)) return `${cmd}.cmd`;
  return cmd;
}

export function resolveSpawnInvocation(
  cmd: string,
  args: string[],
  useShell = defaultShell(),
  isWindows = IS_WINDOWS,
  comSpec = process.env.ComSpec || 'cmd.exe',
): SpawnInvocation {
  if (!isWindows || useShell) {
    return { command: cmd, args, useShell };
  }

  const lower = cmd.toLowerCase();
  if (WINDOWS_CMD_SHIMS.has(lower)) {
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `${cmd}.cmd`, ...args],
      useShell: false,
    };
  }

  return { command: cmd, args, useShell: false };
}

function mergeEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Spawn a command and collect its output.
 * Returns a promise that resolves with stdout, stderr, and exit code.
 */
export function crossSpawn(
  cmd: string,
  args: string[],
  options: CrossSpawnOptions,
): Promise<SpawnResult> {
  const {
    cwd,
    useShell = defaultShell(),
    timeoutMs = 120_000,
    env,
    onProgress,
  } = options;

  return new Promise((resolve, reject) => {
    const invocation = resolveSpawnInvocation(cmd, args, useShell);
    const spawnOpts: SpawnOptions = {
      cwd,
      shell: invocation.useShell,
      env: mergeEnv(env),
    };

    const proc = spawn(invocation.command, invocation.args, spawnOpts);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command "${cmd}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      if (onProgress) {
        for (const line of text.split('\n').filter(Boolean)) {
          onProgress(line);
        }
      }
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (onProgress) {
        for (const line of text.split('\n').filter(Boolean)) {
          onProgress(line);
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn a long-running process (like a dev server) that stays alive.
 * Returns the ChildProcess directly for tracking.
 */
export function crossSpawnLive(
  cmd: string,
  args: string[],
  options: CrossSpawnOptions,
): ChildProcess {
  const {
    cwd,
    useShell = defaultShell(),
    env,
    detached = false,
  } = options;

  const invocation = resolveSpawnInvocation(cmd, args, useShell);
  return spawn(invocation.command, invocation.args, {
    cwd,
    shell: invocation.useShell,
    detached,
    env: mergeEnv(env) ?? process.env,
  });
}

/**
 * Kill a process tree (works cross-platform).
 * Windows: uses taskkill /f /t to kill the process tree.
 * Unix: sends SIGTERM.
 */
export function killProcess(proc: ChildProcess): void {
  if (IS_WINDOWS && proc.pid) {
    spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t']);
  } else {
    proc.kill('SIGTERM');
  }
}
