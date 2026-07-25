/**
 * Phase 12 — Gmail integration: in-process sync scheduler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startMailScheduler } from '../../src/services/mail/mailScheduler.js';
import type { GmailAuthService } from '../../src/services/mail/GmailAuthService.js';
import type { MailCacheService } from '../../src/services/mail/MailCacheService.js';
import type { MailSyncService } from '../../src/services/mail/MailSyncService.js';
import type { GmailSettings, MailSchedulerStatus, MailSyncResult } from '../../src/types/mail.js';

const SETTINGS: GmailSettings = {
  query: 'in:inbox',
  syncIntervalMinutes: 5,
  maxResults: 200,
  needsReauth: false,
};
const INTERVAL_MS = 5 * 60 * 1000;

function okResult(): MailSyncResult {
  return { ok: true, fetched: 1, totalCached: 1, syncedAt: new Date().toISOString() };
}

function failResult(needsReauth = false): MailSyncResult {
  return { ok: false, fetched: 0, totalCached: 0, syncedAt: new Date().toISOString(), error: 'boom', needsReauth };
}

function schedulerHarness(results: () => MailSyncResult | Promise<MailSyncResult>, configured = true) {
  const statuses: MailSchedulerStatus[] = [];
  let syncCalls = 0;
  const auth = { isConfigured: () => configured } as unknown as GmailAuthService;
  const cache = { readSyncState: () => ({}) } as unknown as MailCacheService;
  const sync = {
    sync: async () => {
      syncCalls += 1;
      return results();
    },
  } as unknown as MailSyncService;

  const stop = startMailScheduler((s) => statuses.push(s), {
    auth,
    cache,
    sync,
    settings: () => SETTINGS,
  });
  return { statuses, stop, syncCalls: () => syncCalls };
}

describe('startMailScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits not-configured once and does nothing when gmail is not connected', async () => {
    const { statuses, syncCalls } = schedulerHarness(okResult, false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(statuses).toEqual([{ state: 'not-configured' }]);
    expect(syncCalls()).toBe(0);
  });

  it('syncs immediately, then on every interval tick', async () => {
    const { statuses, stop, syncCalls } = schedulerHarness(okResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCalls()).toBe(1);
    expect(statuses.map((s) => s.state)).toEqual(['syncing', 'idle']);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(syncCalls()).toBe(3);
    stop();
  });

  it('does not overlap ticks while a sync is still running', async () => {
    let resolveSync: ((r: MailSyncResult) => void) | undefined;
    const { stop, syncCalls } = schedulerHarness(
      () => new Promise<MailSyncResult>((resolve) => { resolveSync = resolve; }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // Two intervals elapse while the first sync is still in flight.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(syncCalls()).toBe(1);

    resolveSync?.(okResult());
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncCalls()).toBe(2);
    stop();
  });

  it('backs off to 4x interval after 3 consecutive failures', async () => {
    const { stop, syncCalls } = schedulerHarness(() => failResult());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(syncCalls()).toBe(3);

    // Backed off: one normal interval passes with no tick…
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncCalls()).toBe(3);
    // …but the 4x interval fires.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(syncCalls()).toBe(4);
    stop();
  });

  it('stops entirely on needs-reauth', async () => {
    const { statuses, stop, syncCalls } = schedulerHarness(() => failResult(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.state).toBe('needs-reauth');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
    expect(syncCalls()).toBe(1);
    stop();
  });

  it('disposer stops future ticks and status emissions', async () => {
    const { statuses, stop, syncCalls } = schedulerHarness(okResult);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    const emitted = statuses.length;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(syncCalls()).toBe(1);
    expect(statuses.length).toBe(emitted);
  });
});
