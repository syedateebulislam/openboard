/**
 * pythonRunner — one place that knows how to start a Python interpreter.
 *
 * `python`, `python3` and `py` are all common depending on platform and how
 * Python was installed, so every call site has to try them in turn and treat
 * ENOENT as "try the next name". That loop lived in BillerFetcherService; the
 * Studio needs it three more times (probe, py_compile, dry-run), so it lives
 * here instead of being copied.
 */

import { existsSync } from 'node:fs';
import { crossSpawn } from '../../utils/crossSpawn.js';

/** Interpreters we are willing to spawn. Distinct from BuildService's npm/npx list. */
export const PYTHON_COMMANDS = ['python', 'python3', 'py'] as const;

/**
 * Shape of a plain flag, number or simple path.
 *
 * This is a tripwire, not a shell defence — runPython pins `useShell: false`,
 * so argv reaches the OS untouched and there is nothing to inject into. Its job
 * is to make undeclared free text (an email subject, a merchant name) fail
 * loudly instead of being passed through by accident.
 */
const SAFE_ARG = /^[A-Za-z0-9._:@\\/-]+$/;

/** Control characters are the only thing argv genuinely cannot carry. */
const CONTROL_CHARS = /[\u0000-\u001f]/;

/**
 * Is this argument a real path on disk?
 *
 * Windows paths routinely contain characters SAFE_ARG omits: `~` in 8.3 short
 * names (C:\Users\RUNNER~1), parentheses in "Program Files (x86)", and spaces
 * in ordinary user folders. Rejecting those broke every Python call on such a
 * machine — caught by CI on Windows, invisible on a dev box with a short user
 * name. Resolving the path is exact and unspoofable: either the file is there
 * or it is not, and with no shell involved its punctuation is inert.
 */
function isExistingPath(arg: string): boolean {
  if (CONTROL_CHARS.test(arg)) return false;
  try {
    return existsSync(arg);
  } catch {
    return false;
  }
}

export interface RunPythonOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /**
   * Args exempt from SAFE_ARG because they legitimately contain spaces and
   * punctuation (an email subject, say).
   *
   * Safe only because runPython pins `useShell: false`: each entry is handed to
   * the OS as its own argv slot, so there is no shell to reinterpret quotes,
   * semicolons or backticks. Never lift that pin without removing this.
   */
  freeTextArgs?: string[];
}

export interface PythonResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr joined, for callers that scan output for failure signatures. */
  output: string;
}

/**
 * Run Python with `args`, trying each interpreter name until one starts.
 *
 * Throws only when no interpreter could be started at all, or when the run was
 * aborted. A non-zero exit is returned, not thrown — the fetchers exit 0 on
 * failure anyway, so callers have to inspect output regardless.
 */
export async function runPython(args: string[], options: RunPythonOptions): Promise<PythonResult> {
  const exempt = new Set(options.freeTextArgs ?? []);
  for (const arg of args) {
    if (exempt.has(arg)) continue;
    if (CONTROL_CHARS.test(arg)) {
      throw new Error('Unsafe argument for the Python runner: contains control characters');
    }
    if (SAFE_ARG.test(arg) || isExistingPath(arg)) continue;
    throw new Error(`Unsafe argument for the Python runner: ${arg}`);
  }

  let lastError: Error | undefined;
  for (const command of PYTHON_COMMANDS) {
    try {
      const result = await crossSpawn(command, args, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: {
          // Generated fetchers are executed from here; bytecode caches in the
          // user's scripts folder are noise they never asked for.
          PYTHONDONTWRITEBYTECODE: '1',
          ...options.env,
        },
        signal: options.signal,
        onProgress: options.onProgress,
        // Pinned, not inherited. freeTextArgs deliberately skips SAFE_ARG, and
        // that exemption is only sound because argv never reaches a shell — so
        // this must not silently follow a change to crossSpawn's default.
        useShell: false,
        // Every Python run routed through here is either generated code or a
        // helper handed generated code, and several carry the Gmail App
        // Password in `env`. None of them has any business seeing the rest of
        // this process's environment, so none of them is given it.
        isolateEnv: true,
      });
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        output: `${result.stdout}\n${result.stderr}`,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      // ENOENT here means this interpreter name is absent; try the next one.
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Python interpreter could be started.');
}

/** True when the failure is "Python is not installed", not "the script broke". */
export function isMissingInterpreter(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /ENOENT|not recognized|No such file or directory/i.test(text);
}
