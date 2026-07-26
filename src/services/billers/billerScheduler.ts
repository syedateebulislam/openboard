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
  const recordRun = deps.recordRun
    ?? ((isoTime: string) => new ConfigService().set('billers.lastRunAt', isoTime));

  const baseIntervalMs = initial.syncIntervalMinutes * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let currentIntervalMs = 0;
  let consecutiveFailures = 0;
  let isRunning = false;
  let stopped = false;
  let lastRunAt = initial.lastRunAt;

  // While the startup catch-up is pending it fires sooner than the interval,
  // so report that instead — otherwise the status advertises a later time than
  // the run that will actually happen next.
  let pendingStartupAt: number | undefined;

  const emit = (state: BillerSchedulerStatus['state'], extra: Partial<BillerSchedulerStatus> = {}) => {
    if (stopped) return;
    const nextAt = pendingStartupAt
      ?? (timer ? Date.now() + currentIntervalMs : undefined);
    onStatus({
      state,
      lastRunAt,
      enabledCount: settings().enabledKeys.length,
      nextRunAt: nextAt ? new Date(nextAt).toISOString() : undefined,
      ...extra,
    });
  };

  const stopTimers = () => {
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    timer = undefined;
    startupTimer = undefined;
  };

  const armTimer = (intervalMs: number) => {
    if (stopped || currentIntervalMs === intervalMs) return;
    if (timer) clearInterval(timer);
    currentIntervalMs = intervalMs;
    timer = setInterval(tick, intervalMs);
    // Never keep the process alive just for the invoice loop.
    timer.unref?.();
  };

  const tick = async () => {
    if (isRunning || stopped) return;
    pendingStartupAt = undefined;
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
        armTimer(baseIntervalMs);
        emit('idle', { changedKeys });
        return;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= BACKOFF_AFTER_FAILURES) {
        armTimer(baseIntervalMs * BACKOFF_MULTIPLIER);
      }
      emit('error', {
        changedKeys,
        error: failed.map((result) => `${result.displayName}: ${result.error}`).join(' · '),
      });
    } catch (error: any) {
      if (stopped) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= BACKOFF_AFTER_FAILURES) {
        armTimer(baseIntervalMs * BACKOFF_MULTIPLIER);
      }
      emit('error', { error: error?.message ?? String(error) });
    } finally {
      isRunning = false;
    }
  };

  armTimer(baseIntervalMs);

  // Only run at startup if a full interval already elapsed; otherwise wait out
  // the remainder so reopening the TUI does not re-fetch everything.
  const dueInMs = msUntilDue(initial);
  if (dueInMs === 0) {
    void tick();
  } else {
    pendingStartupAt = Date.now() + dueInMs;
    emit('idle');
    startupTimer = setTimeout(() => { void tick(); }, dueInMs);
    startupTimer.unref?.();
  }

  return () => {
    stopped = true;
    stopTimers();
  };
}
