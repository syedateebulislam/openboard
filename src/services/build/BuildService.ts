import { crossSpawn } from '../../utils/crossSpawn.js';

export type ProgressCallback = (line: string) => void;

export interface BuildResult {
  success: boolean;
  error?: string;
  outputDir?: string;
}

export interface TypeCheckError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface TypeCheckResult {
  success: boolean;
  errors: TypeCheckError[];
}

const RUNTIME_SAFETY_CODES = new Set([
  'TS2304', // Cannot find name
  'TS2448', // Block-scoped variable used before its declaration
  'TS2454', // Variable used before being assigned
  'TS2552', // Cannot find name; did you mean...
  'TS18004', // Shorthand property has no value in scope
]);

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Validate command allowlist
  const allowedCommands = ['npm', 'npx'];
  const isAllowed = allowedCommands.some(allowed => cmd === allowed || cmd.endsWith(`/${allowed}`) || cmd.endsWith(`\\${allowed}`));
  if (!isAllowed) {
    return Promise.reject(new Error(`Command not allowed: ${cmd}`));
  }

  // Validate args don't contain shell metacharacters
  const dangerousChars = /[;&|`$(){}[\]<>!#*?\\]/;
  for (const arg of args) {
    if (dangerousChars.test(arg)) {
      return Promise.reject(new Error(`Potentially dangerous argument detected: ${arg}`));
    }
  }

  return crossSpawn(cmd, args, { cwd, timeoutMs, onProgress, signal });
}

export class BuildService {
  static async install(projectDir: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<BuildResult> {
    // Every generated dashboard gets its own node_modules, so the same React,
    // Vite and Recharts trees are installed again per project. npm has no
    // shared store to opt into, but it does have a local cache — these flags
    // make it use it and stop it doing work nobody asked for:
    //
    //   --prefer-offline  take a package from the cache whenever the cache has
    //                     it, instead of revalidating against the registry
    //   --no-audit        skip the vulnerability report; it is a separate
    //                     network round trip on a generated scaffold
    //   --no-fund         skip the funding message
    //
    // Cold-cache installs on slow machines/CI runners routinely exceed 2
    // minutes; npm itself reports real failures well before this ceiling.
    const { code, stderr } = await runCommand(
      'npm',
      ['install', '--prefer-offline', '--no-audit', '--no-fund'],
      projectDir,
      600_000,
      onProgress,
      signal,
    );
    if (code !== 0) return { success: false, error: stderr };
    return { success: true };
  }

  static async typeCheck(projectDir: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<TypeCheckResult> {
    const { stdout, stderr, code } = await runCommand(
      'npx',
      ['tsc', '--project', 'tsconfig.app.json', '--noEmit'],
      projectDir,
      120_000,
      onProgress,
      signal,
    );
    if (code === 0) return { success: true, errors: [] };

    const output = stdout + stderr;
    const errors = BuildService.parseTscErrors(output);
    return { success: false, errors };
  }

  /**
   * Catch diagnostics that can become immediate browser ReferenceErrors.
   * The validation config follows only src/main.tsx's active import graph and
   * deliberately relaxes ordinary library typing differences.
   */
  static async validateGeneratedCode(
    projectDir: string,
    _onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TypeCheckResult> {
    const { stdout, stderr, code } = await runCommand(
      'npx',
      ['tsc', '--project', 'tsconfig.validate.json', '--noEmit'],
      projectDir,
      120_000,
      // The compiler can emit non-blocking library diagnostics. Report only
      // the runtime-safety subset after classification, not raw stderr.
      undefined,
      signal,
    );
    if (code === 0) return { success: true, errors: [] };
    const output = stdout + stderr;
    const parsed = BuildService.parseTscErrors(output);
    if (parsed.length === 0) {
      return {
        success: false,
        errors: [{
          file: 'tsconfig.validate.json',
          line: 1,
          column: 1,
          code: 'TS_CONFIG',
          message: output.trim() || 'TypeScript validation failed without diagnostic output.',
        }],
      };
    }
    const runtimeErrors = parsed
      .filter((error) => RUNTIME_SAFETY_CODES.has(error.code));
    return { success: runtimeErrors.length === 0, errors: runtimeErrors };
  }

  static parseTscErrors(output: string): TypeCheckError[] {
    const errors: TypeCheckError[] = [];
    // Pattern: file(line,col): error TS1234: message
    const regex = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
      errors.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        code: match[4],
        message: match[5].trim(),
      });
    }
    return errors;
  }

  static formatTypeCheckErrors(errors: TypeCheckError[]): string {
    return errors
      .map((error) => `${error.file}(${error.line},${error.column}): ${error.code} ${error.message}`)
      .join('\n');
  }

  static async build(projectDir: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<BuildResult> {
    const { code, stderr } = await runCommand('npx', ['vite', 'build'], projectDir, 300_000, onProgress, signal);
    if (code !== 0) return { success: false, error: stderr };
    return { success: true, outputDir: 'dist' };
  }

  static async fullBuild(
    projectDir: string,
    options: { timeout?: number; onProgress?: ProgressCallback; signal?: AbortSignal } = {},
  ): Promise<BuildResult> {
    const installResult = await BuildService.install(projectDir, options.onProgress, options.signal);
    if (!installResult.success) return installResult;

    const typeResult = await BuildService.typeCheck(projectDir, options.onProgress, options.signal);
    if (!typeResult.success) {
      return {
        success: false,
        error: BuildService.formatTypeCheckErrors(typeResult.errors),
      };
    }

    return BuildService.build(projectDir, options.onProgress, options.signal);
  }

  static buildRetryPrompt(originalPrompt: string, errors: TypeCheckError[]): string {
    const errorLines = errors.map(e => `  ${e.file} line ${e.line}: ${e.message}`).join('\n');
    return `${originalPrompt}

The previous code had TypeScript errors. Fix ALL of them:

TypeScript errors:
${errorLines}

Generate corrected code that compiles without errors.`;
  }
}
