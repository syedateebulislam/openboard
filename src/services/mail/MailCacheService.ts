/**
 * MailCacheService — local Gmail message cache under ~/.openboard/mail/.
 *
 * messages.json is a plain JSON array of flat MailRow objects: exactly the
 * shape DataParserService.parseJSON ingests, which is what makes the cache a
 * first-class board data source. Writes are atomic (temp file + rename)
 * because boards may re-parse the file while a sync tick is writing it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MailRow, MailSyncState } from '../../types/mail.js';

const MAX_MESSAGES_KEPT = 5000;

function mailDir(configDir?: string): string {
  const root = configDir
    ?? process.env.OPENBOARD_CONFIG_DIR
    ?? join(homedir(), '.openboard');
  return join(root, 'mail');
}

export class MailCacheService {
  private readonly dir: string;

  constructor(configDir?: string) {
    this.dir = mailDir(configDir);
  }

  /** Absolute path of the cache file boards link into board.dataFiles. */
  static getCachePath(configDir?: string): string {
    return join(mailDir(configDir), 'messages.json');
  }

  get cachePath(): string {
    return join(this.dir, 'messages.json');
  }

  private get syncStatePath(): string {
    return join(this.dir, 'sync-state.json');
  }

  readMessages(): MailRow[] {
    if (!existsSync(this.cachePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf-8'));
      return Array.isArray(parsed) ? parsed as MailRow[] : [];
    } catch {
      return [];
    }
  }

  /**
   * Merge new rows into the cache: dedupe by id (new rows win), newest first,
   * capped at MAX_MESSAGES_KEPT. Returns the total cached after the merge.
   */
  upsertMessages(rows: MailRow[]): number {
    const byId = new Map<string, MailRow>();
    for (const row of this.readMessages()) byId.set(row.id, row);
    for (const row of rows) byId.set(row.id, row);

    const merged = [...byId.values()]
      .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`))
      .slice(0, MAX_MESSAGES_KEPT);

    this.writeAtomic(this.cachePath, merged);
    return merged.length;
  }

  readSyncState(): MailSyncState {
    if (!existsSync(this.syncStatePath)) return {};
    try {
      return JSON.parse(readFileSync(this.syncStatePath, 'utf-8')) as MailSyncState;
    } catch {
      return {};
    }
  }

  writeSyncState(state: MailSyncState): void {
    this.writeAtomic(this.syncStatePath, state);
  }

  private writeAtomic(path: string, value: unknown): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    renameSync(tempPath, path);
  }
}
