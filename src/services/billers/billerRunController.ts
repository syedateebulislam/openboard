/**
 * billerRunController — the invoice fetches in flight, so they can be stopped.
 *
 * A fetch can be started by the schedule or by hand, and the two do not know
 * about each other. Without a shared handle, a scheduled run that wedges on a
 * broken fetcher could only be ended by killing the terminal: the screen that
 * shows its output had no way to reach it.
 *
 * This used to hold a single `active` run, on the reasoning that the project
 * lock refuses a second concurrent fetch so more than one could never exist.
 * The lock does refuse the *work*, but not the registration: pressing "Fetch
 * now" during a scheduled run still began a second run, that run immediately
 * bounced off the lock, and its `finally` then cleared the handle belonging to
 * the scheduled fetch still going. The row flipped back to "Fetch now" while a
 * fetch was very much running, and nothing could stop it short of closing the
 * terminal.
 *
 * So the set is the honest model: registration and work are separate, briefly
 * overlapping facts. Ending one run never deregisters another, and stopping
 * aborts everything actually in flight.
 */

export interface ActiveBillerRun {
  controller: AbortController;
  /** 'scheduled' or 'manual' — shown when reporting what was stopped. */
  origin: 'scheduled' | 'manual';
  startedAt: number;
}

/** Insertion-ordered, so the last entry is always the most recently started. */
const live = new Set<ActiveBillerRun>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to run start/stop.
 *
 * The screen showing the "Stop fetch" row reads this state during render. Read
 * without a subscription it only refreshed when something else happened to
 * re-render, so the row could offer to start a fetch that was already running,
 * or to stop one that had finished.
 */
export function subscribeBillerRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register a starting run. The caller must pass the signal into syncEnabled. */
export function beginBillerRun(origin: ActiveBillerRun['origin']): ActiveBillerRun {
  const run: ActiveBillerRun = { controller: new AbortController(), origin, startedAt: Date.now() };
  live.add(run);
  notifyListeners();
  return run;
}

/**
 * Deregister one run, leaving any other still-live run alone.
 *
 * A run that bounced off the project lock finishes in milliseconds; the one
 * holding the lock may have minutes left. The first must not take the second's
 * handle with it.
 */
export function endBillerRun(run: ActiveBillerRun): void {
  if (live.delete(run)) notifyListeners();
}

/**
 * The run in flight, if any — the most recently started when several overlap.
 *
 * Returns the stored object, never a copy, so the identity is stable between
 * notifications and this can back `useSyncExternalStore` directly.
 */
export function activeBillerRun(): ActiveBillerRun | undefined {
  let newest: ActiveBillerRun | undefined;
  for (const run of live) newest = run;
  return newest;
}

/**
 * Ask every running fetch to stop, whoever started it.
 *
 * Returns the newest run that was stopped so the caller can say what it was,
 * or undefined when nothing was running — reporting "stopped" either way
 * taught users to distrust it.
 *
 * The signal breaks the per-biller loop and is passed to the Python child, so a
 * fetcher already spawned is terminated rather than left to finish unwatched.
 */
export function stopBillerRun(): ActiveBillerRun | undefined {
  const newest = activeBillerRun();
  if (!newest) return undefined;
  for (const run of live) run.controller.abort();
  live.clear();
  notifyListeners();
  return newest;
}

/** Tests only — module state would otherwise leak between cases. */
export function clearBillerRuns(): void {
  live.clear();
  notifyListeners();
}
