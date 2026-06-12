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

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
  onProgress?: ProgressCallback,
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

  return crossSpawn(cmd, args, { cwd, timeoutMs, onProgress });
}

export class BuildService {
  static async install(projectDir: string, onProgress?: ProgressCallback): Promise<BuildResult> {
    // Cold-cache installs on slow machines/CI runners routinely exceed 2
    // minutes; npm itself reports real failures well before this ceiling.
    const { code, stderr } = await runCommand('npm', ['install'], projectDir, 600_000, onProgress);
    if (code !== 0) return { success: false, error: stderr };
    return { success: true };
  }

  static async typeCheck(projectDir: string, onProgress?: ProgressCallback): Promise<TypeCheckResult> {
    const { stdout, stderr, code } = await runCommand('npx', ['tsc', '--noEmit'], projectDir, 120_000, onProgress);
    if (code === 0) return { success: true, errors: [] };

    const output = stdout + stderr;
    const errors = BuildService.parseTscErrors(output);
    return { success: false, errors };
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

  static async build(projectDir: string, onProgress?: ProgressCallback): Promise<BuildResult> {
    const { code, stderr } = await runCommand('npx', ['vite', 'build'], projectDir, 300_000, onProgress);
    if (code !== 0) return { success: false, error: stderr };
    return { success: true, outputDir: 'dist' };
  }

  static async fullBuild(
    projectDir: string,
    options: { timeout?: number; onProgress?: ProgressCallback } = {},
  ): Promise<BuildResult> {
    const installResult = await BuildService.install(projectDir, options.onProgress);
    if (!installResult.success) return installResult;

    const typeResult = await BuildService.typeCheck(projectDir, options.onProgress);
    if (!typeResult.success) {
      return {
        success: false,
        error: typeResult.errors
          .map(e => `${e.file}(${e.line},${e.column}): ${e.message}`)
          .join('\n'),
      };
    }

    return BuildService.build(projectDir, options.onProgress);
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
