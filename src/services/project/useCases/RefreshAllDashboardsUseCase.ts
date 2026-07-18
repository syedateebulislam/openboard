import type { BoardConfig } from '../../../types/board.js';
import type { DashboardUpdateResult, UpdateProgress } from '../DashboardUpdateService.js';

interface ProjectLock {
  success: boolean;
  error?: string;
  release(): void;
}

export interface RefreshAllDashboardsPorts {
  listBoards(): BoardConfig[];
  projectDir(boards: BoardConfig[]): string | undefined;
  acquireLock(projectDir: string): ProjectLock;
  refresh(board: BoardConfig, projectDir: string, onProgress?: UpdateProgress): Promise<DashboardUpdateResult>;
  syncComposition(projectDir: string, onProgress?: UpdateProgress): Promise<string[]>;
  finalize(board: BoardConfig, writtenFiles: string[], count: number, onProgress?: UpdateProgress): Promise<DashboardUpdateResult>;
  reconcile(results: DashboardUpdateResult[], finalized: DashboardUpdateResult, projectDir: string): DashboardUpdateResult[];
  failure(board: BoardConfig, message: string, errorCode?: string): DashboardUpdateResult;
}

/** Application use case for a batch refresh. It owns ordering, not infrastructure. */
export class RefreshAllDashboardsUseCase {
  constructor(private readonly ports: RefreshAllDashboardsPorts) {}

  async execute(onProgress?: UpdateProgress): Promise<DashboardUpdateResult[]> {
    const boards = this.ports.listBoards();
    if (boards.length === 0) return [];

    const projectDir = this.ports.projectDir(boards);
    if (!projectDir) {
      return boards.map((board) => this.ports.failure(board, 'No generated app workspace found.', 'E_UNKNOWN'));
    }

    const lock = this.ports.acquireLock(projectDir);
    if (!lock.success) {
      return boards.map((board) => this.ports.failure(board, lock.error ?? 'Project lock failed', 'E_LOCKED'));
    }

    try {
      const generated: DashboardUpdateResult[] = [];
      for (const board of boards) {
        onProgress?.(`\n=== Updating ${board.title} ===`);
        generated.push(await this.ports.refresh(board, projectDir, onProgress));
      }

      const successful = generated.filter(
        (result): result is DashboardUpdateResult & { board: BoardConfig } => result.success && Boolean(result.board),
      );
      if (successful.length === 0) return generated;

      const written = successful.flatMap((result) => result.writtenFiles ?? []);
      written.push(...await this.ports.syncComposition(projectDir, onProgress));
      const representative = { ...successful.at(-1)!.board, outputDir: projectDir };
      const finalized = await this.ports.finalize(
        representative,
        [...new Set(written)],
        successful.length,
        onProgress,
      );
      return this.ports.reconcile(generated, finalized, projectDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return boards.map((board) => this.ports.failure(board, message));
    } finally {
      lock.release();
    }
  }
}

