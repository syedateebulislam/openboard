import type { BoardConfig } from '../../types/board.js';
import type { PipelineReporter } from './pipelinePhases.js';

export interface BuildPipelineResult {
  success: boolean;
  error?: string;
}

export interface DashboardBuildPipelinePorts {
  boards(): BoardConfig[];
  syncManifest(projectDir: string, boards: BoardConfig[]): Promise<{ missingBoards: string[] }>;
  syncShell(projectDir: string): Promise<string[]>;
  hasDependencies(projectDir: string): boolean;
  install(projectDir: string, onProgress: (line: string) => void): Promise<BuildPipelineResult>;
  build(projectDir: string, onProgress: (line: string) => void): Promise<BuildPipelineResult>;
  repair(projectDir: string, writtenFiles: string[], error: string | undefined): Promise<BuildPipelineResult>;
}

/** Ordered, independently testable stages that produce a deployable dashboard build. */
export class DashboardBuildPipeline {
  constructor(private readonly ports: DashboardBuildPipelinePorts) {}

  async execute(projectDir: string, writtenFiles: string[], reporter: PipelineReporter): Promise<BuildPipelineResult> {
    const boards = this.ports.boards();
    const manifest = await this.ports.syncManifest(projectDir, boards);
    reporter.log(`Synced deterministic dashboard manifest (${boards.length} dashboard(s)).`);
    if (manifest.missingBoards.length > 0) {
      reporter.log(`Warning: regenerate missing component(s): ${manifest.missingBoards.join(', ')}`);
    }

    try {
      const synced = await this.ports.syncShell(projectDir);
      reporter.log(`Synced ${synced.length} shell file(s) from template.`);
    } catch (error) {
      reporter.log(`Warning: shell sync skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    reporter.phase('build');
    if (!this.ports.hasDependencies(projectDir)) {
      reporter.log('Installing dependencies...');
      const installed = await this.ports.install(projectDir, reporter.progress);
      if (!installed.success) return { success: false, error: `Install failed: ${installed.error}` };
    }

    reporter.log('Building project...');
    let built = await this.ports.build(projectDir, reporter.progress);
    if (!built.success && writtenFiles.length > 0) {
      built = await this.ports.repair(projectDir, writtenFiles, built.error);
    }
    if (!built.success) return { success: false, error: `Build failed: ${built.error}` };
    reporter.log('Build successful');
    return { success: true };
  }
}

