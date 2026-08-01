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

/** Rows visible at once. Enough to watch new lines arrive and keep context. */
export const LOG_PANE_HEIGHT = 3;

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
 * Wrap every entry to `width` and flatten to display lines.
 *
 * One appended entry can occupy several rows, so the pane must count wrapped
 * lines rather than entries — otherwise a single long error would silently
 * push everything else out of a 3-row window.
 */
export function flattenLogLines(
  entries: string[],
  width: number,
  maxLines: number = MAX_VIEW_LINES,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const entry of entries) {
    for (const line of wrapText(entry, safeWidth)) lines.push(line);
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
): LogViewport {
  const lines = flattenLogLines(entries, width);
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
