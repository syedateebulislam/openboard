/**
 * logTone — the one or two lines in a log that should catch the eye.
 *
 * The activity log is a wall of dim fetcher output, and the lines that actually
 * answer "did anything happen?" were the same colour as everything else. A run
 * that found new invoices and one that found none looked identical until you
 * read every line.
 *
 * Tone is carried as a leading glyph rather than as structure, because the log
 * store is a plain string array shared with a scheduled run that has no screen
 * mounted, and the viewport wraps entries into rows before anything renders.
 * A glyph survives both. Use these sparingly: if half the log is green, none of
 * it is.
 */

export const TONE_MARKS = {
  /** Something changed and it is worth noticing. */
  success: '✓',
  /** A deliberate no-op. Not a problem, but not news either. */
  muted: '·',
} as const;

export type LogTone = keyof typeof TONE_MARKS;

/** Prefix a line so the pane renders it in the matching colour. */
export function toneLine(tone: LogTone, text: string): string {
  return `${TONE_MARKS[tone]} ${text}`;
}

/**
 * The tone of an already-rendered row, or undefined for ordinary output.
 *
 * Reads the row rather than the entry, so a wrapped continuation line falls
 * back to the default colour — the highlight is the first line, which is the
 * one carrying the summary.
 */
export function toneOf(row: string): LogTone | undefined {
  const first = row.trimStart()[0];
  if (first === TONE_MARKS.success) return 'success';
  if (first === TONE_MARKS.muted) return 'muted';
  return undefined;
}
