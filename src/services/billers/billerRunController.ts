/**
 * billerRunController — the one in-flight invoice fetch, so it can be stopped.
 *
 * A fetch can be started by the schedule or by hand, and the two do not know
 * about each other. Without a shared handle, a scheduled run that wedges on a
 * broken fetcher could only be ended by killing the terminal: the screen that
 * shows its output had no way to reach it.
 *
 * Module-level because there is at most one run per process — the project lock
 * already refuses a second concurrent fetch, so a registry of many would be
 * modelling a state that cannot happen.
 */

export interface ActiveBillerRun {
  controller: AbortController;
  /** 'scheduled' or 'manual' — shown when reporting what was stopped. */
  origin: 'scheduled' | 'manual';
  startedAt: number;
}

let active: ActiveBillerRun | undefined;

/** Register a starting run. The caller must pass the signal into syncEnabled. */
export function beginBillerRun(origin: ActiveBillerRun['origin']): ActiveBillerRun {
  const run: ActiveBillerRun = { controller: new AbortController(), origin, startedAt: Date.now() };
  active = run;
  return run;
}

/**
 * Clear the run, but only if it is still the current one.
 *
 * A late finisher must not deregister the run that replaced it, or the screen
 * would offer to stop a fetch that no longer exists while the real one runs on.
 */
export function endBillerRun(run: ActiveBillerRun): void {
  if (active === run) active = undefined;
}

/** The run in flight, if any. */
export function activeBillerRun(): ActiveBillerRun | undefined {
  return active;
}

/**
 * Ask the running fetch to stop, whoever started it.
 *
 * Returns what was stopped so the caller can say so, or undefined when nothing
 * was running — reporting "stopped" either way taught users to distrust it.
 *
 * The signal breaks the per-biller loop and is passed to the Python child, so a
 * fetcher already spawned is terminated rather than left to finish unwatched.
 */
export function stopBillerRun(): ActiveBillerRun | undefined {
  if (!active) return undefined;
  const run = active;
  run.controller.abort();
  active = undefined;
  return run;
}
