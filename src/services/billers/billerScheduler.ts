/**
 * billerScheduler — in-process invoice-fetch loop for the TUI session.
 *
 * Lifecycle contract: the interval lives inside this Node process, so it starts
 * with the CLI and dies with the terminal — no daemon, no leftover processes —
 * and the timer is unref'd so it never keeps the process alive on exit.
 *
 * A tick is expensive: it spawns Python IMAP scans and can trigger LLM
 * dashboard builds, so running one on every launch would be both slow and
 * costly. Instead the last run time is persisted and the loop only fires on
 * startup when a full interval has actually elapsed — otherwise the default
 * 6-hour interval would practically never be reached inside a single TUI
 * session.
 *
 * Because the loop is silent by construction, App wires its status into the
 * chat header: an interval nobody can see is indistinguishable from a broken
 * one, which is exactly how this last read to users.
 */

import type { BillerRunResult, BillerSchedulerStatus, BillerSettings } from '../../types/billers.js';
import { BillerFetcherService } from './BillerFetcherService.js';
import { appendBillerActivity } from './billerActivityLog.js';
import { beginBillerRun, endBillerRun } from './billerRunController.js';
import { ConfigService } from '../config/ConfigService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';

const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_MULTIPLIER = 4;

export interface BillerSchedulerDeps {
  fetcher?: BillerFetcherService;
  settings?: () => BillerSettings;
  /** Persist the completed-run timestamp. Injected in tests. */
  recordRun?: (isoTime: string) => void;
  /**
   * Where a scheduled run's output goes. Defaults to the shared activity log so
   * the settings screen can show it — a scheduled fetch used to run completely
   * silently, leaving "Last run" advancing above an empty log pane.
   */
  onProgress?: (line: string) => void;
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

/**
 * Whether a finished manual fetch should re-anchor the schedule.
 *
 * An empty result set means no fetcher ran at all — nothing was enabled, or the
 * scripts folder went missing. Stamping lastRunAt there pushed the next
 * scheduled run out by a full interval for work that never happened, so pressing
 * "Fetch now" on a misconfigured setup quietly suppressed the loop.
 *
 * Failed runs still anchor, matching the scheduler's own tick: a biller that is
 * broken today must not make every launch retry it forever.
 */
export function shouldAnchorRun(results: BillerRunResult[]): boolean {
  return results.length > 0;
}

/** True when a scheduled run could actually do something. */
export function isBillerSyncConfigured(settings: BillerSettings): boolean {
  return Boolean(settings.scriptsDir && settings.email && settings.appPassword)
    && settings.enabledKeys.length > 0;
}

/**
 * Identity of a running scheduler: restart it only when this changes.
 *
 * A loop already re-reads settings on every tick, so enabled billers, the
 * address and the password all take effect without restarting anything. Only
 * two things are captured at arm time and cannot be picked up otherwise: the
 * interval, and whether the loop should exist at all.
 *
 * Restarting for everything else was actively harmful. Arming schedules an
 * overdue run immediately, so once the schedule was due, every settings change
 * kicked off a full fetch — toggling a biller started one, which is what made
 * opening the fetchers screen look like it triggered a run.
 */
export function billerSchedulerArmKey(settings: BillerSettings): string {
  return `${isBillerSyncConfigured(settings)}:${settings.syncIntervalMinutes}`;
}

/**
 * Delay until the next run, measured from when the previous run STARTED.
 *
 * The configured interval is the period between runs, not the gap between one
 * finishing and the next starting. Scheduling a full interval from completion
 * made every cycle drift by however long the fetch took, so "every 7 minutes"
 * actually fetched every 7 minutes plus a fetch — and the drift compounded for
 * as long as the session stayed open.
 *
 * Returns 0 when the run already outlasted its own interval: the next one is
 * due the moment this one ends, which is the honest answer when the work takes
 * longer than the period asked for.
 */
export function msUntilNextRun(startedAt: number, intervalMs: number, now = Date.now()): number {
  return Math.max(0, intervalMs - (now - startedAt));
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
  const onProgress = deps.onProgress ?? appendBillerActivity;

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
    // The schedule anchors on this, not on when the fetch finishes — see
    // msUntilNextRun for why the difference compounds.
    const startedAt = Date.now();
    emit('running');
    onProgress(`Scheduled fetch started ${new Date(startedAt).toLocaleTimeString()}`);
    const run = beginBillerRun('scheduled');
    /**
     * Anchoring must not depend on the fetcher calling back. onStart is the
     * better moment — it survives a run cut short — but a fetcher that never
     * fires it would otherwise leave the schedule permanently overdue, which is
     * exactly the failure this change set out to fix.
     */
    let anchored = false;
    const anchor = () => {
      if (anchored) return;
      anchored = true;
      lastRunAt = new Date(startedAt).toISOString();
      recordRun(lastRunAt);
    };

    try {
      // Forward the per-biller output: without this a scheduled run produced no
      // lines at all and the settings screen's log pane stayed empty.
      const results = await fetcher.syncEnabled({
        onProgress,
        signal: run.controller.signal,
        // Anchor the moment work begins, not when it ends. A nine-biller fetch
        // takes minutes; quitting the TUI or re-arming the scheduler in between
        // used to throw the anchor away for work already done, so every launch
        // saw an overdue schedule and fetched the lot again.
        onStart: anchor,
      });
      if (stopped) return;
      if (results.skipped === 'locked') {
        // An interval change can re-arm while a manual/previous scheduled run
        // is still building dashboards. The lock protects the data; do not
        // misreport that as "no billers enabled" or move lastRunAt forward for
        // work this scheduler did not perform.
        scheduleNext(baseIntervalMs);
        emit('idle');
        return;
      }
      // Fallback for a fetcher that did not signal its start. An empty result
      // set still must not anchor: no fetcher ran, and stamping the schedule
      // there would push the next run out a full interval for work never done.
      if (results.length > 0) anchor();

      const failed = results.filter((result) => !result.ok);
      const changedKeys = results.filter((result) => result.changed).map((result) => result.key);

      onProgress(
        results.length === 0
          ? 'Scheduled fetch finished — no billers are enabled.'
          : failed.length > 0
            ? `Scheduled fetch finished with ${failed.length} failure(s): ${failed.map((r) => `${r.displayName} (${r.error})`).join(' · ')}`
            : changedKeys.length > 0
              ? `Scheduled fetch finished — new invoices for ${changedKeys.join(', ')}; dashboards refreshed.`
              : `Scheduled fetch finished — ran ${results.length} fetcher(s), no new invoices.`,
      );

      if (failed.length === 0) {
        consecutiveFailures = 0;
        intervalMs = baseIntervalMs;
        scheduleNext(msUntilNextRun(startedAt, intervalMs));
        emit('idle', { changedKeys });
        return;
      }

      consecutiveFailures += 1;
      intervalMs = intervalAfterFailure();
      scheduleNext(msUntilNextRun(startedAt, intervalMs));
      emit('error', {
        changedKeys,
        error: failed.map((result) => `${result.displayName}: ${result.error}`).join(' · '),
      });
    } catch (error: any) {
      if (stopped) return;
      consecutiveFailures += 1;
      intervalMs = intervalAfterFailure();
      scheduleNext(msUntilNextRun(startedAt, intervalMs));
      onProgress(`Scheduled fetch failed: ${error?.message ?? String(error)}`);
      emit('error', { error: error?.message ?? String(error) });
    } finally {
      isRunning = false;
      endBillerRun(run);
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
