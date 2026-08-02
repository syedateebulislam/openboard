/**
 * billerActivityLog — one buffered log of everything the invoice fetchers do.
 *
 * Scheduled runs happen in the background, with no screen necessarily mounted.
 * The settings screen's own log state could therefore only ever show what the
 * "Fetch now" button did: "Last run" and "Next run" advanced while the pane
 * below them stayed empty, which read as the schedule not working at all.
 *
 * So the log lives outside React. The scheduler writes to it whether or not
 * anyone is looking, and a screen that opens later still sees the recent
 * history instead of a blank box.
 */

import { sanitizeErrorMessage } from '../../utils/logger.js';

/** Retained lines. A few hundred is plenty for a pane that shows three. */
const MAX_ACTIVITY_LINES = 500;

let lines: string[] = [];
const listeners = new Set<() => void>();
let notificationQueued = false;

/**
 * A dashboard build can stream hundreds of progress lines in one turn. Notify
 * React once after that burst rather than causing a nested render for every
 * line; the snapshot still contains every retained entry when it is read.
 */
function notifyListeners(): void {
  if (notificationQueued) return;
  notificationQueued = true;
  queueMicrotask(() => {
    notificationQueued = false;
    for (const listener of listeners) listener();
  });
}

/** Snapshot for useSyncExternalStore — identity changes only on append. */
export function getBillerActivity(): string[] {
  return lines;
}

export function appendBillerActivity(line: string): void {
  // Lines here are raw fetcher stdout/stderr and error messages. Nothing
  // upstream guarantees they are free of credentials, so redact on the way in
  // — the pane renders this and the buffer outlives the run.
  const next = [...lines, sanitizeErrorMessage(line)];
  lines = next.length > MAX_ACTIVITY_LINES ? next.slice(-MAX_ACTIVITY_LINES) : next;
  notifyListeners();
}

export function subscribeBillerActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only — module state would otherwise leak between cases. */
export function clearBillerActivity(): void {
  lines = [];
  notifyListeners();
}

export const billerActivityLog = {
  getLines: getBillerActivity,
  append: appendBillerActivity,
  subscribe: subscribeBillerActivity,
};

export default billerActivityLog;
