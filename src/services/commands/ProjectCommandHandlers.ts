import type { ProjectManager } from '../project/ProjectManager.js';

export type CommandProgress = (line: string) => void;

export interface ProjectCommandResult {
  success: boolean;
  error?: string;
  url?: string;
}

/** UI-agnostic handlers for project commands shared by chat and future surfaces. */
export class ProjectCommandHandlers {
  constructor(private readonly projects: ProjectManager) {}

  async build(projectDir: string, progress: CommandProgress, signal?: AbortSignal): Promise<ProjectCommandResult> {
    const info = this.projects.getProjectInfo(projectDir);
    if (info && !info.hasNodeModules) {
      progress('Installing dependencies...');
      const installed = await this.projects.install(projectDir, progress, signal);
      if (!installed.success) return { success: false, error: `Install failed: ${installed.error}` };
    }
    const built = await this.projects.build(projectDir, progress, signal);
    if (!built.success) return { success: false, error: `Build failed: ${built.error}` };
    progress(`Build complete. Output: ${built.outputDir}`);
    return { success: true };
  }

  async preview(projectDir: string, progress: CommandProgress): Promise<ProjectCommandResult> {
    const restart = this.projects.isPreviewRunning(projectDir);
    if (restart) {
      progress('Stopping current preview server...');
      this.projects.stopPreview(projectDir);
    }

    const info = this.projects.getProjectInfo(projectDir);
    if (info && !info.hasNodeModules) {
      progress('Installing dependencies...');
      const installed = await this.projects.install(projectDir, progress);
      if (!installed.success) return { success: false, error: `Install failed: ${installed.error}` };
    }

    if (restart) {
      progress('Rebuilding with latest changes...');
      const built = await this.projects.build(projectDir, progress);
      if (!built.success) return { success: false, error: `Build failed: ${built.error}` };
      progress('Build successful');
    }

    const preview = await this.projects.preview(projectDir, undefined, progress);
    if (!preview.success) return { success: false, error: `Preview failed: ${preview.error}` };
    const url = preview.url || 'http://127.0.0.1:5173';
    progress(`Preview running at ${url}`);
    return { success: true, url };
  }
}

