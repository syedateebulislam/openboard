import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crossSpawnLive, killProcess } from '../../utils/crossSpawn.js';
import type { ProgressCallback } from '../build/BuildService.js';

export interface PreviewResult {
  success: boolean;
  error?: string;
  url?: string;
  port?: number;
  process?: ChildProcess;
}

// Global registry to track running dev servers
const runningServers = new Map<string, ChildProcess>();

export class PreviewService {
  static async start(
    projectDir: string,
    port = 5173,
    onProgress?: ProgressCallback,
  ): Promise<PreviewResult> {
    try {
      // Check if already running
      if (runningServers.has(projectDir)) {
        return {
          success: true,
          url: `http://localhost:${port}`,
          port,
          process: runningServers.get(projectDir),
        };
      }

      // Check if package.json exists
      const packageJsonPath = join(projectDir, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return {
          success: false,
          error: 'No package.json found in project directory',
        };
      }

      // Start dev server using crossSpawnLive (handles platform differences)
      const proc = crossSpawnLive('npm', ['run', 'dev'], {
        cwd: projectDir,
        env: { PORT: port.toString() },
        detached: false,
      });

      // Track the process
      runningServers.set(projectDir, proc);

      let output = '';
      let hasStarted = false;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!hasStarted) {
            PreviewService.stop(projectDir);
            reject(new Error('Dev server failed to start within 30 seconds'));
          }
        }, 30_000);

        proc.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          output += text;
          if (onProgress) {
            for (const line of text.split('\n').filter(Boolean)) {
              onProgress(line);
            }
          }

          // Check for common dev server start patterns
          if (
            text.includes('Local:') ||
            text.includes('localhost') ||
            text.includes('ready in') ||
            text.includes('server running')
          ) {
            hasStarted = true;
            clearTimeout(timeout);
            resolve({
              success: true,
              url: `http://localhost:${port}`,
              port,
              process: proc,
            });
          }
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          output += text;
          if (onProgress) {
            for (const line of text.split('\n').filter(Boolean)) {
              onProgress(line);
            }
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          runningServers.delete(projectDir);
          reject(err);
        });

        proc.on('close', (code) => {
          runningServers.delete(projectDir);
          if (!hasStarted && code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Dev server exited with code ${code}: ${output}`));
          }
        });
      });
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static stop(projectDir: string): boolean {
    const proc = runningServers.get(projectDir);
    if (proc) {
      try {
        killProcess(proc);
        runningServers.delete(projectDir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  static isRunning(projectDir: string): boolean {
    const proc = runningServers.get(projectDir);
    if (!proc) return false;

    try {
      return !proc.killed && proc.exitCode === null;
    } catch {
      return false;
    }
  }

  static stopAll(): void {
    for (const [projectDir] of runningServers) {
      PreviewService.stop(projectDir);
    }
  }

  static getRunningServers(): string[] {
    return Array.from(runningServers.keys());
  }
}

// Cleanup on process exit
process.on('exit', () => {
  PreviewService.stopAll();
});

process.on('SIGINT', () => {
  PreviewService.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  PreviewService.stopAll();
  process.exit(0);
});
