/**
 * pythonRunner — one place that knows how to start a Python interpreter.
 *
 * `python`, `python3` and `py` are all common depending on platform and how
 * Python was installed, so every call site has to try them in turn and treat
 * ENOENT as "try the next name". That loop lived in BillerFetcherService; the
 * Studio needs it three more times (probe, py_compile, dry-run), so it lives
 * here instead of being copied.
 */

import { crossSpawn } from '../../utils/crossSpawn.js';

/** Interpreters we are willing to spawn. Distinct from BuildService's npm/npx list. */
export const PYTHON_COMMANDS = ['python', 'python3', 'py'] as const;

/** Only numeric/enum/path args ever reach argv — no user free-text is passed through. */
const SAFE_ARG = /^[A-Za-z0-9._:@\\/-]+$/;

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
    if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe argument for the Python runner: ${arg}`);
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
