/**
 * Phase 12 — Gmail integration: sync orchestration and the data-pipeline
 * contract (cached messages.json parses as a regular board data source).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MailCacheService } from '../../src/services/mail/MailCacheService.js';
import { MailSyncService } from '../../src/services/mail/MailSyncService.js';
import { GmailClient, type GmailMessageMetadata } from '../../src/services/mail/GmailClient.js';
import { GmailReauthRequiredError } from '../../src/services/mail/GmailAuthService.js';
import { DataParserService } from '../../src/services/data/DataParserService.js';
import { DataAnalyzer } from '../../src/services/data/DataAnalyzer.js';
import type { GmailSettings } from '../../src/types/mail.js';

const SETTINGS: GmailSettings = {
  query: 'in:inbox',
  syncIntervalMinutes: 5,
  maxResults: 200,
  needsReauth: false,
};

function metadata(id: string, dateUtc: string, from: string): GmailMessageMetadata {
  return {
    id,
    threadId: `t-${id}`,
    snippet: `snippet ${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(new Date(dateUtc).getTime()),
    sizeEstimate: 2048,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: `Subject ${id}` },
      ],
    },
  };
}

function fakeClient(messages: GmailMessageMetadata[], seen: { queries: string[] }) {
  return {
    listMessages: async (query: string) => {
      seen.queries.push(query);
      return messages.map((m) => ({ id: m.id, threadId: m.threadId }));
    },
    getMessages: async (refs: Array<{ id: string }>) =>
      refs.map((ref) => messages.find((m) => m.id === ref.id)!),
    getProfile: async () => ({ emailAddress: 'me@example.com', historyId: 'h-42' }),
  } as unknown as GmailClient;
}

describe('MailSyncService', () => {
  let dir: string;
  let cache: MailCacheService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-mail-sync-'));
    cache = new MailCacheService(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('first sync uses newer_than:30d; later syncs use an after: watermark', async () => {
    const seen = { queries: [] as string[] };
    const client = fakeClient([metadata('m1', '2026-07-15T09:30:00Z', 'a@b.com')], seen);
    const sync = new MailSyncService({ client, cache, settings: () => SETTINGS });

    const first = await sync.sync();
    expect(first.ok).toBe(true);
    expect(seen.queries[0]).toBe('in:inbox newer_than:30d');

    const second = await sync.sync();
    expect(second.ok).toBe(true);
    const afterMatch = seen.queries[1].match(/^in:inbox after:(\d+)$/);
    expect(afterMatch).not.toBeNull();
    // Watermark is lastSyncAt minus a one-hour overlap.
    const watermark = Number(afterMatch![1]) * 1000;
    const lastSync = new Date(first.syncedAt).getTime();
    expect(lastSync - watermark).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
  });

  it('records sync state and merges fetched rows into the cache', async () => {
    const client = fakeClient([
      metadata('m1', '2026-07-15T09:30:00Z', '"Acme" <orders@acme.com>'),
      metadata('m2', '2026-07-16T10:00:00Z', 'news@daily.io'),
    ], { queries: [] });
    const sync = new MailSyncService({ client, cache, settings: () => SETTINGS });

    const result = await sync.sync();
    expect(result).toMatchObject({ ok: true, fetched: 2, totalCached: 2 });

    const state = cache.readSyncState();
    expect(state.lastSyncAt).toBe(result.syncedAt);
    expect(state.lastSyncCount).toBe(2);
    expect(state.lastHistoryId).toBe('h-42');
    expect(cache.readMessages().map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('captures errors into sync state without throwing', async () => {
    const client = {
      listMessages: async () => { throw new Error('network down'); },
    } as unknown as GmailClient;
    const sync = new MailSyncService({ client, cache, settings: () => SETTINGS });

    const result = await sync.sync();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
    expect(result.needsReauth).toBe(false);
    expect(cache.readSyncState().lastError).toContain('network down');
  });

  it('flags needsReauth for revoked credentials', async () => {
    const client = {
      listMessages: async () => { throw new GmailReauthRequiredError(); },
    } as unknown as GmailClient;
    const sync = new MailSyncService({ client, cache, settings: () => SETTINGS });

    const result = await sync.sync();
    expect(result.ok).toBe(false);
    expect(result.needsReauth).toBe(true);
  });

  it('synced cache parses through the board data pipeline', async () => {
    const client = fakeClient([
      metadata('m1', '2026-07-14T08:00:00Z', '"Acme" <orders@acme.com>'),
      metadata('m2', '2026-07-15T09:00:00Z', 'news@daily.io'),
      metadata('m3', '2026-07-16T10:00:00Z', 'other@acme.com'),
      metadata('m4', '2026-07-17T11:00:00Z', 'digest@daily.io'),
      metadata('m5', '2026-07-18T12:00:00Z', 'billing@acme.com'),
    ], { queries: [] });
    await new MailSyncService({ client, cache, settings: () => SETTINGS }).sync();

    const parsed = await DataParserService.parse(cache.cachePath);
    expect(parsed.format).toBe('json');
    expect(parsed.rows).toHaveLength(5);

    const analysis = DataAnalyzer.analyze(parsed);
    const dateColumn = analysis.columns.find((c) => c.name === 'date');
    expect(dateColumn?.type).toBe('date');
    expect(dateColumn?.dateFormat).toBe('YYYY-MM-DD');
    const domainColumn = analysis.columns.find((c) => c.name === 'fromDomain');
    expect(domainColumn?.type).toBe('string');
    expect(domainColumn?.isCategorical).toBe(true);
    expect(domainColumn?.uniqueValues).toEqual(expect.arrayContaining(['acme.com', 'daily.io']));
  });
});
