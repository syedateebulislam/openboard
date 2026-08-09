import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { crossSpawnLive, killProcess } from '../../utils/crossSpawn.js';
import type { ProgressCallback } from '../build/BuildService.js';

export interface PreviewResult {
  success: boolean;
  error?: string;
  url?: string;
  port?: number;
  process?: ChildProcess;
}

interface RunningPreview {
  process: ChildProcess;
  port: number;
  url: string;
}

// Global registry to track running dev servers and their actual bound ports.
const runningServers = new Map<string, RunningPreview>();

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available preview port found between ${preferred} and ${preferred + 19}`);
}

export class PreviewService {
  static async start(
    projectDir: string,
    port = 5173,
    onProgress?: ProgressCallback,
  ): Promise<PreviewResult> {
    try {
      // Check if already running
      const existing = runningServers.get(projectDir);
      if (existing && !existing.process.killed && existing.process.exitCode === null) {
        return {
          success: true,
          url: existing.url,
          port: existing.port,
          process: existing.process,
        };
      }
      if (existing) runningServers.delete(projectDir);

      // Check if package.json exists
      const packageJsonPath = join(projectDir, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return {
          success: false,
          error: 'No package.json found in project directory',
        };
      }

      const selectedPort = await findAvailablePort(port);
      const url = `http://127.0.0.1:${selectedPort}`;

      // Pass the port directly to Vite. Vite does not read the generic PORT
      // environment variable, which previously made OpenBoardCLI report a URL
      // different from the port Vite actually selected.
      const proc = crossSpawnLive('npm', [
        'run',
        'dev',
        '--',
        '--host',
        '127.0.0.1',
        '--port',
        String(selectedPort),
        '--strictPort',
      ], {
        cwd: projectDir,
        detached: false,
      });

      // Track the process
      runningServers.set(projectDir, { process: proc, port: selectedPort, url });

      let output = '';
      let hasStarted = false;

      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result: PreviewResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          runningServers.delete(projectDir);
          reject(error);
        };
        const timeout = setTimeout(() => {
          if (!hasStarted) {
            PreviewService.stop(projectDir);
            fail(new Error(`Dev server failed to start within 30 seconds. Output: ${output.slice(-4000)}`));
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
          const normalized = output.replace(/\u001b\[[0-9;]*m/g, '');
          if (/Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i.test(normalized) || /ready in/i.test(normalized)) {
            hasStarted = true;
            finish({
              success: true,
              url,
              port: selectedPort,
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
          fail(err);
        });

        proc.on('close', (code) => {
          runningServers.delete(projectDir);
          if (!hasStarted && code !== 0) {
            fail(new Error(`Dev server exited with code ${code}: ${output.slice(-4000)}`));
          }
        });
      });
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static stop(projectDir: string): boolean {
    const running = runningServers.get(projectDir);
    if (running) {
      try {
        killProcess(running.process);
        runningServers.delete(projectDir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  static isRunning(projectDir: string): boolean {
    const running = runningServers.get(projectDir);
    if (!running) return false;

    try {
      return !running.process.killed && running.process.exitCode === null;
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
