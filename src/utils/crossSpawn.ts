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
  /** Optional stdin payload. Useful for credentials without exposing argv. */
  stdin?: string;
  /** Cancel the process and its children. */
  signal?: AbortSignal;
  /** Maximum stdout/stderr retained per stream. Defaults to 8 MiB. */
  maxOutputBytes?: number;
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
    detached = !IS_WINDOWS,
    stdin,
    signal,
    maxOutputBytes = 8 * 1024 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error(`Command "${cmd}" was aborted`), { name: 'AbortError' }));
      return;
    }
    const invocation = resolveSpawnInvocation(cmd, args, useShell);
    const spawnOpts: SpawnOptions = {
      cwd,
      shell: invocation.useShell,
      env: mergeEnv(env),
      detached,
    };

    const proc = spawn(invocation.command, invocation.args, spawnOpts);
    let stdout = '';
    let stderr = '';
    let stdoutLine = '';
    let stderrLine = '';
    let settled = false;

    const appendBounded = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length <= maxOutputBytes ? next : next.slice(-maxOutputBytes);
    };

    const emitLines = (chunk: string, pending: string, setPending: (value: string) => void) => {
      if (!onProgress) return;
      const parts = (pending + chunk).split(/\r?\n/);
      setPending(parts.pop() ?? '');
      for (const line of parts) if (line) onProgress(line);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      killProcess(proc);
      fail(new Error(`Command "${cmd}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onAbort = () => {
      killProcess(proc);
      fail(Object.assign(new Error(`Command "${cmd}" was aborted`), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout = appendBounded(stdout, text);
      emitLines(text, stdoutLine, (value) => { stdoutLine = value; });
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr = appendBounded(stderr, text);
      emitLines(text, stderrLine, (value) => { stderrLine = value; });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onProgress && stdoutLine) onProgress(stdoutLine);
      if (onProgress && stderrLine) onProgress(stderrLine);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err) => {
      fail(err);
    });

    if (stdin !== undefined) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }
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
    const killer = spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
    killer.unref();
  } else {
    if (proc.pid) {
      try {
        // crossSpawn uses a detached process group on Unix so descendants die too.
        process.kill(-proc.pid, 'SIGTERM');
        return;
      } catch {
        // Live/non-detached children may not own a process group.
      }
    }
    proc.kill('SIGTERM');
  }
}
