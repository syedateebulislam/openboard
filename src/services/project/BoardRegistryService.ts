import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '../config/ConfigService.js';
import type { BoardConfig } from '../../types/board.js';
import { PromptHistoryService } from './PromptHistoryService.js';

function isBoardConfig(value: unknown): value is BoardConfig {
  if (!value || typeof value !== 'object') return false;
  const board = value as Partial<BoardConfig>;
  return (
    typeof board.id === 'string' &&
    typeof board.name === 'string' &&
    typeof board.title === 'string' &&
    typeof board.outputDir === 'string' &&
    Array.isArray(board.dataFiles)
  );
}

export class BoardRegistryService {
  private config: ConfigService;

  constructor(config?: ConfigService) {
    this.config = config ?? new ConfigService();
  }

  listBoards(): BoardConfig[] {
    const raw = this.config.get('boards');
    if (!Array.isArray(raw)) return [];
    return raw.filter(isBoardConfig);
  }

  upsertBoard(board: BoardConfig): BoardConfig[] {
    const boards = this.listBoards();
    const index = boards.findIndex((b) => b.id === board.id || b.name === board.name);
    const updated = index >= 0
      ? boards.map((b, i) => (i === index ? board : b))
      : [...boards, board];
    this.config.set('boards', updated);
    new PromptHistoryService(this.config).ensure(board.id);
    return updated;
  }

  removeBoard(id: string): BoardConfig[] {
    const updated = this.listBoards().filter((board) => board.id !== id);
    this.config.set('boards', updated);
    new PromptHistoryService(this.config).delete(id);
    return updated;
  }

  getSharedProjectDir(): string | undefined {
    const projectDir = this.config.get('workspace.projectDir');
    if (typeof projectDir !== 'string') return undefined;
    if (!existsSync(join(projectDir, 'package.json'))) return undefined;
    return projectDir;
  }

  setSharedProjectDir(projectDir: string): void {
    this.config.set('workspace.projectDir', projectDir);
  }
}

export default BoardRegistryService;
