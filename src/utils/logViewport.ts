/**
 * logViewport — fixed-height scrollback for the screens' progress logs.
 *
 * The settings and management screens stream progress through an onProgress
 * callback, and each of them used to bind that to a single string that the next
 * line overwrote: one flickering line, no history, and nothing to scroll. This
 * turns an append-only list of raw log lines into the exact rows a small pane
 * renders, plus its scrollbar.
 *
 * It is the same problem the chat log already solves, so the scroll maths are
 * reused wholesale from chatViewport. Only the input shape differs — plain
 * strings here, role-labelled ChatMessages there — which is why flattenMessages
 * is not what gets called.
 *
 * Everything here is pure: the maths are testable without a terminal.
 */
import {
  MAX_VIEW_LINES,
  clampOffset,
  maxScrollOffset,
  scrollbarColumn,
  visibleLines,
  wrapText,
} from './chatViewport.js';

/**
 * Rows visible at once. Enough to watch new lines arrive and keep context.
 *
 * Six rather than three: a single fetcher line often wraps to two, so a
 * three-row pane frequently showed barely more than one message and scrolled
 * the rest away before it could be read.
 */
export const LOG_PANE_HEIGHT = 6;

export interface LogViewport {
  /** Exactly the lines to draw, oldest first. May be shorter than the height. */
  rows: string[];
  /** One entry per row; true where the scrollbar thumb sits. */
  scrollbar: boolean[];
  /** Wrapped lines hidden above the window. */
  hiddenOlder: number;
  /** Wrapped lines hidden below it — non-zero only when scrolled back. */
  hiddenNewer: number;
  /** Total wrapped lines retained, after the scrollback cap. */
  totalLines: number;
}

/**
 * Per-entry wrap cache, keyed by position in the log.
 *
 * The chat log has had one of these all along; this pane did not, so every
 * appended line re-wrapped the entire scrollback from scratch — the work grew
 * with the log while the new work per line stayed constant. Log entries are
 * append-only and never edited, so a cached entry is valid until the width
 * changes; `entry` is still compared so a cleared or replaced log cannot serve
 * a previous run's lines at the same index.
 */
export type LogWrapCache = Map<number, { entry: string; width: number; lines: string[] }>;

/**
 * Wrap every entry to `width` and flatten to display lines.
 *
 * One appended entry can occupy several rows, so the pane must count wrapped
 * lines rather than entries — otherwise a single long error would silently
 * push everything else out of the window.
 */
export function flattenLogLines(
  entries: string[],
  width: number,
  maxLines: number = MAX_VIEW_LINES,
  cache?: LogWrapCache,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const cached = cache?.get(index);
    let wrapped: string[];
    if (cached && cached.entry === entry && cached.width === safeWidth) {
      wrapped = cached.lines;
    } else {
      wrapped = wrapText(entry, safeWidth);
      cache?.set(index, { entry, width: safeWidth, lines: wrapped });
    }
    for (const line of wrapped) lines.push(line);
  }

  // Entries only ever leave the cache by being dropped from the log, so trim
  // anything past the end rather than letting it grow without bound.
  if (cache && cache.size > entries.length) {
    for (const index of cache.keys()) {
      if (index >= entries.length) cache.delete(index);
    }
  }

  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

/**
 * Resolve an append-only log into a bottom-anchored window.
 *
 * `offset` counts wrapped lines hidden below the window, so 0 always means
 * "pinned to the newest line" — the state a running action should be in.
 */
export function logViewport(
  entries: string[],
  width: number,
  height: number = LOG_PANE_HEIGHT,
  offset: number = 0,
  cache?: LogWrapCache,
): LogViewport {
  const lines = flattenLogLines(entries, width, MAX_VIEW_LINES, cache);
  const safeHeight = Math.max(1, height);
  const effective = clampOffset(offset, lines.length, safeHeight);

  return {
    rows: visibleLines(lines, safeHeight, effective),
    scrollbar: scrollbarColumn(lines.length, safeHeight, effective),
    hiddenOlder: maxScrollOffset(lines.length, safeHeight) - effective,
    hiddenNewer: effective,
    totalLines: lines.length,
  };
}
