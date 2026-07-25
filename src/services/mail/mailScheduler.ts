/**
 * mailScheduler — in-process Gmail sync loop for the TUI session.
 *
 * Deliberately "Method 1": the interval lives inside this Node process, so it
 * starts when the CLI launches and dies with the terminal — no daemon, no
 * leftover processes. Modeled on startHeartbeat (services/llm/heartbeat.ts):
 * start returns a disposer, and the timer is unref'd so it never keeps the
 * process alive on exit.
 *
 * Failure policy for unattended running: after 3 consecutive failed ticks the
 * interval backs off to 4x; a needs-reauth result stops the loop entirely
 * (reconnecting from Settings restarts it via the App effect).
 */

import type { GmailSettings, MailSchedulerStatus } from '../../types/mail.js';
import { GmailAuthService } from './GmailAuthService.js';
import { MailCacheService } from './MailCacheService.js';
import { MailSyncService } from './MailSyncService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';

const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_MULTIPLIER = 4;

export interface MailSchedulerDeps {
  auth?: GmailAuthService;
  sync?: MailSyncService;
  cache?: MailCacheService;
  settings?: () => GmailSettings;
}

export function startMailScheduler(
  onStatus: (status: MailSchedulerStatus) => void,
  deps: MailSchedulerDeps = {},
): () => void {
  const auth = deps.auth ?? new GmailAuthService();
  if (!auth.isConfigured()) {
    onStatus({ state: 'not-configured' });
    return () => {};
  }

  const cache = deps.cache ?? new MailCacheService();
  const syncService = deps.sync ?? new MailSyncService({ auth, cache });
  const settings = deps.settings ?? (() => new TypedConfigRepository().getGmailSettings());

  const baseIntervalMs = settings().syncIntervalMinutes * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentIntervalMs = 0;
  let consecutiveFailures = 0;
  let isSyncing = false;
  let stopped = false;

  const emit = (state: MailSchedulerStatus['state'], extra: Partial<MailSchedulerStatus> = {}) => {
    if (stopped) return;
    const syncState = cache.readSyncState();
    onStatus({
      state,
      lastSyncAt: syncState.lastSyncAt,
      totalCached: syncState.totalCached,
      nextSyncAt: timer ? new Date(Date.now() + currentIntervalMs).toISOString() : undefined,
      ...extra,
    });
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const armTimer = (intervalMs: number) => {
    if (stopped || currentIntervalMs === intervalMs) return;
    stopTimer();
    currentIntervalMs = intervalMs;
    timer = setInterval(tick, intervalMs);
    // Never keep the process alive just for the mail loop.
    timer.unref?.();
  };

  const tick = async () => {
    if (isSyncing || stopped) return;
    isSyncing = true;
    emit('syncing');
    try {
      const result = await syncService.sync();
      if (stopped) return;
      if (result.ok) {
        consecutiveFailures = 0;
        armTimer(baseIntervalMs);
        emit('idle');
        return;
      }
      if (result.needsReauth) {
        stopTimer();
        currentIntervalMs = 0;
        emit('needs-reauth', { error: result.error });
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= BACKOFF_AFTER_FAILURES) {
        armTimer(baseIntervalMs * BACKOFF_MULTIPLIER);
      }
      emit('error', { error: result.error });
    } finally {
      isSyncing = false;
    }
  };

  armTimer(baseIntervalMs);
  void tick();

  return () => {
    stopped = true;
    stopTimer();
  };
}
