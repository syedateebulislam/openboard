/**
 * Phase 12 — Gmail integration: local mail cache.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MailCacheService } from '../../src/services/mail/MailCacheService.js';
import type { MailRow } from '../../src/types/mail.js';

function row(overrides: Partial<MailRow>): MailRow {
  return {
    id: 'id-1',
    threadId: 'thread-1',
    date: '2026-07-15',
    time: '09:00',
    from: 'Sender',
    fromAddress: 'sender@example.com',
    fromDomain: 'example.com',
    subject: 'Hello',
    snippet: 'Hi there',
    labels: 'INBOX',
    category: 'primary',
    unread: false,
    hasAttachment: false,
    sizeKb: 10,
    ...overrides,
  };
}

describe('MailCacheService', () => {
  let dir: string;
  let cache: MailCacheService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-mail-cache-'));
    cache = new MailCacheService(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('returns empty data before any sync', () => {
    expect(cache.readMessages()).toEqual([]);
    expect(cache.readSyncState()).toEqual({});
  });

  it('dedupes by id with new rows winning, sorted newest first', () => {
    cache.upsertMessages([
      row({ id: 'a', date: '2026-07-10', subject: 'old subject' }),
      row({ id: 'b', date: '2026-07-12' }),
    ]);
    const total = cache.upsertMessages([
      row({ id: 'a', date: '2026-07-10', subject: 'updated subject' }),
      row({ id: 'c', date: '2026-07-14' }),
    ]);

    const messages = cache.readMessages();
    expect(total).toBe(3);
    expect(messages.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(messages.find((m) => m.id === 'a')?.subject).toBe('updated subject');
  });

  it('caps the cache at 5000 messages, keeping the newest', () => {
    const rows = Array.from({ length: 5010 }, (_, i) => row({
      id: `id-${i}`,
      date: `2026-0${(i % 6) + 1}-15`,
    }));
    const total = cache.upsertMessages(rows);
    expect(total).toBe(5000);
    const dates = cache.readMessages().map((m) => m.date);
    expect(dates[0] >= dates[dates.length - 1]).toBe(true);
  });

  it('writes valid JSON with no leftover temp file', () => {
    cache.upsertMessages([row({ id: 'a' })]);
    const raw = readFileSync(cache.cachePath, 'utf-8');
    expect(Array.isArray(JSON.parse(raw))).toBe(true);
    expect(() => readFileSync(`${cache.cachePath}.tmp`, 'utf-8')).toThrow();
  });

  it('round-trips sync state', () => {
    cache.writeSyncState({ lastSyncAt: '2026-07-15T09:00:00.000Z', totalCached: 3 });
    expect(cache.readSyncState()).toEqual({ lastSyncAt: '2026-07-15T09:00:00.000Z', totalCached: 3 });
  });

  it('getCachePath honors OPENBOARD_CONFIG_DIR', () => {
    process.env.OPENBOARD_CONFIG_DIR = dir;
    try {
      expect(MailCacheService.getCachePath()).toBe(join(dir, 'mail', 'messages.json'));
    } finally {
      delete process.env.OPENBOARD_CONFIG_DIR;
    }
  });
});
