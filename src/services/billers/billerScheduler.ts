/**
 * billerScheduler — in-process invoice-fetch loop for the TUI session.
 *
 * Same lifecycle contract as mailScheduler (services/mail/mailScheduler.ts):
 * the interval lives inside this Node process, so it starts with the CLI and
 * dies with the terminal — no daemon, no leftover processes — and the timer is
 * unref'd so it never keeps the process alive on exit.
 *
 * It differs from the mail loop in one important way. A mail tick is a cheap
 * API call, so that loop syncs immediately on every launch. A biller tick
 * spawns Python IMAP scans and can trigger LLM dashboard builds, so running one
 * on every launch would be both slow and expensive. Instead the last run time
 * is persisted and the loop only fires on startup when a full interval has
 * actually elapsed — otherwise the default 6-hour interval would practically
 * never be reached inside a single TUI session.
 */

import type { BillerSchedulerStatus, BillerSettings } from '../../types/billers.js';
import { BillerFetcherService } from './BillerFetcherService.js';
import { ConfigService } from '../config/ConfigService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';

const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_MULTIPLIER = 4;

export interface BillerSchedulerDeps {
  fetcher?: BillerFetcherService;
  settings?: () => BillerSettings;
  /** Persist the completed-run timestamp. Injected in tests. */
  recordRun?: (isoTime: string) => void;
}

/**
 * Persist a completed run so the schedule re-anchors on it.
 *
 * Manual fetches count. "Fetch now" and `openboard agent billers sync` do the
 * same work a scheduled tick does, so leaving lastRunAt untouched made the loop
 * think it was still overdue and fire a duplicate fetch moments later.
 */
export function recordBillerRun(isoTime: string = new Date().toISOString()): string {
  new ConfigService().set('billers.lastRunAt', isoTime);
  return isoTime;
}

/** True when a scheduled run could actually do something. */
export function isBillerSyncConfigured(settings: BillerSettings): boolean {
  return Boolean(settings.scriptsDir && settings.email && settings.appPassword)
    && settings.enabledKeys.length > 0;
}

/** Milliseconds until the next run is due; 0 when it is already overdue. */
export function msUntilDue(settings: BillerSettings, now = Date.now()): number {
  const intervalMs = settings.syncIntervalMinutes * 60 * 1000;
  if (!settings.lastRunAt) return 0;
  const last = Date.parse(settings.lastRunAt);
  if (Number.isNaN(last)) return 0;
  // A clock jump backwards should not park the loop for hours.
  if (last > now) return intervalMs;
  return Math.max(intervalMs - (now - last), 0);
}

export function startBillerScheduler(
  onStatus: (status: BillerSchedulerStatus) => void,
  deps: BillerSchedulerDeps = {},
): () => void {
  const settings = deps.settings ?? (() => new TypedConfigRepository().getBillerSettings());
  const initial = settings();
  if (!isBillerSyncConfigured(initial)) {
    onStatus({ state: 'not-configured' });
    return () => {};
  }

  const fetcher = deps.fetcher ?? new BillerFetcherService({ settings });
  const recordRun = deps.recordRun ?? ((isoTime: string) => { recordBillerRun(isoTime); });

  const baseIntervalMs = initial.syncIntervalMinutes * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intervalMs = baseIntervalMs;
  let nextRunAt: number | undefined;
  let consecutiveFailures = 0;
  let isRunning = false;
  let stopped = false;
  let lastRunAt = initial.lastRunAt;

  const emit = (state: BillerSchedulerStatus['state'], extra: Partial<BillerSchedulerStatus> = {}) => {
    if (stopped) return;
    onStatus({
      state,
      lastRunAt,
      enabledCount: settings().enabledKeys.length,
      // Report the time the pending timer will actually fire. Deriving it from
      // "now + interval" at emit time made the advertised next run slide
      // forward on every status change and never match the real one.
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : undefined,
      ...extra,
    });
  };

  /**
   * One self-rescheduling timer, always re-anchored on the run that just
   * finished. A fixed setInterval was pinned to process start instead: after a
   * startup catch-up the next tick landed a partial interval later (a 60-minute
   * interval could fire 50 minutes after the previous run), and because the
   * scheduler is restarted on every settings change, that interval was also
   * reset to zero each time — so on a long interval the periodic tick could
   * keep being pushed out and never fire at all.
   */
  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const delay = Math.max(0, delayMs);
    nextRunAt = Date.now() + delay;
    timer = setTimeout(() => { void tick(); }, delay);
    // Never keep the process alive just for the invoice loop.
    timer.unref?.();
  };

  /** Slow the loop down only once failures look persistent, not on a blip. */
  const intervalAfterFailure = () => (
    consecutiveFailures >= BACKOFF_AFTER_FAILURES ? baseIntervalMs * BACKOFF_MULTIPLIER : baseIntervalMs
  );

  const tick = async () => {
    if (isRunning || stopped) return;
    isRunning = true;
    emit('running');
    try {
      const results = await fetcher.syncEnabled();
      if (stopped) return;
      lastRunAt = new Date().toISOString();
      recordRun(lastRunAt);

      const failed = results.filter((result) => !result.ok);
      const changedKeys = results.filter((result) => result.changed).map((result) => result.key);

      if (failed.length === 0) {
        consecutiveFailures = 0;
        intervalMs = baseIntervalMs;
        scheduleNext(intervalMs);
        emit('idle', { changedKeys });
        return;
      }

      consecutiveFailures += 1;
      intervalMs = intervalAfterFailure();
      scheduleNext(intervalMs);
      emit('error', {
        changedKeys,
        error: failed.map((result) => `${result.displayName}: ${result.error}`).join(' · '),
      });
    } catch (error: any) {
      if (stopped) return;
      consecutiveFailures += 1;
      intervalMs = intervalAfterFailure();
      scheduleNext(intervalMs);
      emit('error', { error: error?.message ?? String(error) });
    } finally {
      isRunning = false;
    }
  };

  // Only run at startup if a full interval already elapsed; otherwise wait out
  // the remainder so reopening the TUI does not re-fetch everything.
  scheduleNext(msUntilDue(initial));
  emit('idle');

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
