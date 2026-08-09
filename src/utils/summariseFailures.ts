/**
 * Collapse a batch of failures into a line worth reading.
 *
 * Batch operations fail as a group far more often than individually: one
 * project lock, one missing workspace, one dead network. Joining every result's
 * error verbatim then repeats a single cause once per dashboard — a real report
 * read "Project is locked by another OpenBoardCLI run (pid 2700, since ...). Retry
 * after it finishes." nine times in one line, filling the log pane and pushing
 * everything that led up to it out of view.
 *
 * Identical messages collapse to one entry with a count. Distinct ones are all
 * kept: those are genuinely different problems and the user needs each.
 */

/** `["a", "a", "b"]` -> `"a (×2); b"`, in first-seen order. */
export function summariseFailures(messages: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const raw of messages) {
    const message = (raw ?? '').trim() || 'Unknown error';
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return [...counts]
    .map(([message, count]) => (count > 1 ? `${message} (×${count})` : message))
    .join('; ');
}
