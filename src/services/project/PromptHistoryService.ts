import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../config/ConfigService.js';

export interface PromptHistoryEntry {
  id: string;
  boardId: string;
  boardName: string;
  boardTitle: string;
  source: 'initial' | 'manual' | 'update';
  prompt: string;
  writtenFiles: string[];
  dataSummary?: string;
  createdAt: string;
}

export class PromptHistoryService {
  private historyDir: string;

  constructor(config?: ConfigService) {
    const cfg = config ?? new ConfigService();
    this.historyDir = join(dirname(cfg.configPath), 'prompt-history');
  }

  getHistoryPath(boardId: string): string {
    return join(this.historyDir, `${boardId}.json`);
  }

  read(boardId: string): PromptHistoryEntry[] {
    const path = this.getHistoryPath(boardId);
    if (!existsSync(path)) return [];

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      return Array.isArray(parsed) ? parsed as PromptHistoryEntry[] : [];
    } catch {
      return [];
    }
  }

  ensure(boardId: string): void {
    mkdirSync(this.historyDir, { recursive: true });
    const path = this.getHistoryPath(boardId);
    if (!existsSync(path)) {
      writeFileSync(path, '[]\n', 'utf-8');
    }
  }

  append(entry: Omit<PromptHistoryEntry, 'id' | 'createdAt'>): PromptHistoryEntry[] {
    mkdirSync(this.historyDir, { recursive: true });
    const updated = [
      ...this.read(entry.boardId),
      {
        ...entry,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      },
    ];
    writeFileSync(this.getHistoryPath(entry.boardId), JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    return updated;
  }

  delete(boardId: string): void {
    rmSync(this.getHistoryPath(boardId), { force: true });
  }
}

export default PromptHistoryService;
