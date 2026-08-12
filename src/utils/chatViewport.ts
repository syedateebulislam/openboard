/**
 * chatViewport — turns chat history into a fixed-height, line-addressable
 * viewport for the TUI chat log.
 *
 * The log scrolls by RENDERED LINE, not by message. Paging by message made
 * PgUp/PgDn move an unpredictable distance (a one-line prompt and a sixty-line
 * build log counted the same) and left the head of any long message
 * unreachable, because each message was truncated to its tail. Wrapping is
 * computed here rather than left to Ink so the scrollbar and the page step
 * agree with what actually lands on screen.
 *
 * Everything in this module is pure: the scroll maths are testable without a
 * terminal.
 */
import stringWidth from 'string-width';
import type { ChatMessage } from '../types/board.js';

/** Role label column ('You: ', 'LLM: ', …) — fixed width so text aligns. */
export const LABEL_WIDTH = 5;

const LABELS: Record<ChatMessage['role'], string> = {
  user: 'You: ',
  assistant: 'LLM: ',
  system: 'Sys: ',
  error: 'Err: ',
};

/**
 * Upper bound on retained display lines. Bounds the wrap/slice work when a
 * session accumulates megabytes of build logs; the oldest lines fall off the
 * top, mirroring a terminal scrollback limit.
 */
export const MAX_VIEW_LINES = 4000;

export interface ChatLine {
  key: string;
  role: ChatMessage['role'];
  /** Role label on a message's first line, blank padding on continuations. */
  label: string;
  text: string;
  /** True on the final line of a streaming message — carries the cursor block. */
  streaming: boolean;
}

/** Per-message wrap cache: streaming re-renders must not re-wrap all history. */
export type WrapCache = Map<string, { content: string; width: number; lines: string[] }>;

/**
 * Columns a string occupies in a terminal.
 *
 * Not the same as `.length`, which is what this used to measure. A CJK
 * character and most emoji occupy two columns while counting as one (or, for
 * emoji, often two) code units, so a line of Japanese wrapped at `width`
 * characters drew at roughly twice the width and overflowed the frame. For
 * ASCII the two agree exactly, so nothing about existing behaviour moves.
 */
function displayWidth(text: string): number {
  return stringWidth(text);
}

/**
 * Split `text` at `width` display columns.
 *
 * Needed for the hard-break path: slicing by code units would cut a
 * double-width character's line in half by column count, and can cut a
 * surrogate pair or an emoji ZWJ sequence in half outright. Iterating by code
 * point and accumulating width breaks only where a terminal would.
 */
function sliceToWidth(text: string, width: number): [string, string] {
  let taken = '';
  let used = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (used + charWidth > width) break;
    taken += char;
    used += charWidth;
  }
  // A single character wider than the whole line: emit it anyway, or the loop
  // that calls this never advances.
  if (taken === '') {
    const [first] = text;
    return [first ?? '', text.slice(first?.length ?? 0)];
  }
  return [taken, text.slice(taken.length)];
}

/**
 * Word-wrap to `width` columns, preserving explicit newlines and hard-breaking
 * tokens (URLs, minified JSON) that cannot fit on a line of their own.
 */
export function wrapText(text: string, width: number): string[] {
  const paragraphs = text.replace(/\t/g, '  ').split('\n');
  if (width <= 0) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (displayWidth(paragraph) <= width) {
      out.push(paragraph);
      continue;
    }

    let current = '';
    const push = (word: string) => {
      let rest = word;
      while (displayWidth(rest) > width) {
        const [head, tail] = sliceToWidth(rest, width);
        out.push(head);
        rest = tail;
      }
      current = rest;
    };

    for (const word of paragraph.split(' ')) {
      if (current === '') {
        push(word);
      } else if (displayWidth(current) + 1 + displayWidth(word) <= width) {
        current += ` ${word}`;
      } else {
        out.push(current);
        current = '';
        push(word);
      }
    }
    out.push(current);
  }

  return out;
}

/**
 * Flatten the history into the exact lines the viewport will render.
 *
 * `width` is the full content width of the log column; the label column is
 * subtracted here so continuation lines stay aligned under the first.
 */
export function flattenMessages(
  messages: ChatMessage[],
  width: number,
  cache?: WrapCache,
  maxLines: number = MAX_VIEW_LINES,
): ChatLine[] {
  const textWidth = Math.max(1, width - LABEL_WIDTH);
  const blank = ' '.repeat(LABEL_WIDTH);
  const lines: ChatLine[] = [];

  for (const message of messages) {
    const cached = cache?.get(message.id);
    let wrapped: string[];
    if (cached && cached.content === message.content && cached.width === textWidth) {
      wrapped = cached.lines;
    } else {
      wrapped = wrapText(message.content, textWidth);
      cache?.set(message.id, { content: message.content, width: textWidth, lines: wrapped });
    }

    wrapped.forEach((text, index) => {
      lines.push({
        key: `${message.id}:${index}`,
        role: message.role,
        label: index === 0 ? LABELS[message.role] : blank,
        text,
        streaming: Boolean(message.isStreaming) && index === wrapped.length - 1,
      });
    });
  }

  if (cache && cache.size > messages.length) {
    const live = new Set(messages.map((m) => m.id));
    for (const id of cache.keys()) {
      if (!live.has(id)) cache.delete(id);
    }
  }

  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

/** Lines that can be hidden above the viewport. 0 when everything fits. */
export function maxScrollOffset(totalLines: number, viewportHeight: number): number {
  return Math.max(0, totalLines - Math.max(1, viewportHeight));
}

/** Clamp a bottom-anchored offset (0 = pinned to the newest line). */
export function clampOffset(offset: number, totalLines: number, viewportHeight: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(totalLines, viewportHeight));
}

/** PgUp/PgDn distance: a full page minus one line of context overlap. */
export function pageStep(viewportHeight: number): number {
  return Math.max(1, viewportHeight - 1);
}

/**
 * The window of lines to render, given how many lines are hidden below it.
 *
 * Generic over the line type: the chat log passes ChatLine[], the progress-log
 * pane passes plain strings, and both want identical bottom-anchored windowing.
 */
export function visibleLines<T>(lines: T[], viewportHeight: number, offset: number): T[] {
  const height = Math.max(1, viewportHeight);
  const safeOffset = clampOffset(offset, lines.length, height);
  const end = lines.length - safeOffset;
  return lines.slice(Math.max(0, end - height), end);
}

/**
 * Scrollbar column: one entry per viewport row, `true` where the thumb sits.
 * An all-`true` column means the whole log already fits on screen.
 */
export function scrollbarColumn(totalLines: number, viewportHeight: number, offset: number): boolean[] {
  const height = Math.max(1, viewportHeight);
  const maxOffset = maxScrollOffset(totalLines, height);
  if (maxOffset === 0) return new Array(height).fill(true);

  const thumbSize = Math.min(height, Math.max(1, Math.round((height * height) / totalLines)));
  const hiddenAbove = maxOffset - clampOffset(offset, totalLines, height);
  const travel = height - thumbSize;
  const thumbTop = Math.min(travel, Math.max(0, Math.round((travel * hiddenAbove) / maxOffset)));

  return Array.from({ length: height }, (_, row) => row >= thumbTop && row < thumbTop + thumbSize);
}
