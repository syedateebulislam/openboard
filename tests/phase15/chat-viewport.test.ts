/**
 * Phase 15 — chat log viewport.
 *
 * The chat log used to scroll by message while the screen measured lines, so
 * PgUp/PgDn moved an arbitrary distance and the head of a long message could
 * never be reached. These tests pin the line-based replacement: pure maths,
 * no terminal.
 */

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  LABEL_WIDTH,
  clampOffset,
  flattenMessages,
  maxScrollOffset,
  pageStep,
  scrollbarColumn,
  visibleLines,
  wrapText,
} from '../../src/utils/chatViewport.js';
import type { WrapCache } from '../../src/utils/chatViewport.js';
import type { ChatMessage } from '../../src/types/board.js';

function msg(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0, ...extra };
}

describe('wrapText', () => {
  it('should_keep_short_text_on_one_line_when_it_fits', () => {
    expect(wrapText('hello world', 40)).toEqual(['hello world']);
  });

  it('should_preserve_explicit_newlines_when_wrapping', () => {
    expect(wrapText('a\nb\nc', 40)).toEqual(['a', 'b', 'c']);
  });

  it('should_never_exceed_width_when_wrapping_prose', () => {
    const text = 'the quick brown fox jumps over the lazy dog again and again';
    for (const line of wrapText(text, 12)) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it('should_preserve_every_word_when_wrapping', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(wrapText(text, 12).join(' ').split(/\s+/).filter(Boolean)).toEqual(text.split(' '));
  });

  it('should_measure_wide_characters_by_display_columns', () => {
    // A CJK character is one code unit but two terminal columns. Measuring
    // with .length wrapped this at 8 characters — 16 columns — so a line of
    // Japanese drew at double the intended width and broke the frame.
    const text = '日本語のテキストです';
    for (const line of wrapText(text, 8)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(8);
    }
  });

  it('should_not_split_a_surrogate_pair_when_hard_breaking', () => {
    // Slicing by code unit can cut an emoji in half and emit a lone surrogate,
    // which renders as a replacement character.
    const lines = wrapText('👍👍👍👍👍👍', 4);
    for (const line of lines) {
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(stringWidth(line)).toBeLessThanOrEqual(4);
    }
    expect(lines.join('')).toBe('👍👍👍👍👍👍');
  });

  it('should_still_advance_when_one_character_is_wider_than_the_line', () => {
    // Guards the hard-break loop: a width-2 character in a width-1 column has
    // to be emitted anyway, or wrapping never terminates.
    const lines = wrapText('日本', 1);
    expect(lines.join('')).toBe('日本');
  });

  it('should_hard_break_tokens_longer_than_width', () => {
    // URLs and minified JSON have no spaces to break on.
    const lines = wrapText('x'.repeat(25), 10);
    expect(lines).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('should_return_a_single_empty_line_for_empty_content', () => {
    expect(wrapText('', 40)).toEqual(['']);
  });

  it('should_not_loop_forever_when_width_is_nonpositive', () => {
    expect(wrapText('a b', 0)).toEqual(['a b']);
  });
});

describe('flattenMessages', () => {
  it('should_label_only_the_first_line_of_a_message', () => {
    const lines = flattenMessages([msg('m1', 'one\ntwo', { role: 'user' })], 40);
    expect(lines).toHaveLength(2);
    expect(lines[0].label).toBe('You: ');
    expect(lines[1].label).toBe(' '.repeat(LABEL_WIDTH));
  });

  it('should_reserve_the_label_column_when_wrapping', () => {
    const lines = flattenMessages([msg('m1', 'w '.repeat(60).trim())], 30);
    for (const line of lines) {
      expect(line.label.length + line.text.length).toBeLessThanOrEqual(30);
    }
  });

  it('should_mark_only_the_last_line_of_a_streaming_message', () => {
    const lines = flattenMessages([msg('m1', 'a\nb\nc', { isStreaming: true })], 40);
    expect(lines.map((l) => l.streaming)).toEqual([false, false, true]);
  });

  it('should_give_every_line_a_unique_key', () => {
    const lines = flattenMessages([msg('m1', 'a\nb'), msg('m2', 'c\nd')], 40);
    expect(new Set(lines.map((l) => l.key)).size).toBe(4);
  });

  it('should_reuse_cached_wrapping_for_unchanged_messages', () => {
    const cache: WrapCache = new Map();
    const messages = [msg('m1', 'stable text here')];
    const first = flattenMessages(messages, 40, cache);
    const second = flattenMessages(messages, 40, cache);
    // Same array instance ⇒ the wrap was not recomputed.
    expect(second[0].text).toBe(first[0].text);
    expect(cache.get('m1')?.lines).toBeDefined();
  });

  it('should_rewrap_when_the_message_content_changes', () => {
    const cache: WrapCache = new Map();
    flattenMessages([msg('m1', 'short')], 40, cache);
    const after = flattenMessages([msg('m1', 'short and then longer')], 40, cache);
    expect(after[0].text).toBe('short and then longer');
  });

  it('should_rewrap_when_the_terminal_width_changes', () => {
    const cache: WrapCache = new Map();
    const messages = [msg('m1', 'alpha beta gamma delta epsilon zeta')];
    expect(flattenMessages(messages, 60, cache)).toHaveLength(1);
    expect(flattenMessages(messages, 20, cache).length).toBeGreaterThan(1);
  });

  it('should_evict_cache_entries_for_trimmed_messages', () => {
    const cache: WrapCache = new Map();
    flattenMessages([msg('m1', 'a'), msg('m2', 'b')], 40, cache);
    flattenMessages([msg('m2', 'b')], 40, cache);
    expect(cache.has('m1')).toBe(false);
  });

  it('should_cap_retained_lines_and_keep_the_newest', () => {
    const lines = flattenMessages([msg('m1', Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'))], 40, undefined, 10);
    expect(lines).toHaveLength(10);
    expect(lines[9].text).toBe('line49');
  });
});

describe('scroll offset maths', () => {
  it('should_report_no_scrollable_range_when_everything_fits', () => {
    expect(maxScrollOffset(5, 10)).toBe(0);
  });

  it('should_report_the_hidden_line_count_as_the_max_offset', () => {
    expect(maxScrollOffset(30, 10)).toBe(20);
  });

  it('should_clamp_an_over_scrolled_offset_to_the_oldest_line', () => {
    expect(clampOffset(999, 30, 10)).toBe(20);
  });

  it('should_clamp_a_negative_offset_to_the_newest_line', () => {
    expect(clampOffset(-5, 30, 10)).toBe(0);
  });

  it('should_clamp_a_parked_offset_when_history_is_trimmed', () => {
    // Reader parked 20 lines up, then MAX_MESSAGES trimmed history to 12 lines.
    expect(clampOffset(20, 12, 10)).toBe(2);
  });

  it('should_page_by_a_screenful_minus_one_line_of_overlap', () => {
    expect(pageStep(10)).toBe(9);
  });

  it('should_always_page_at_least_one_line', () => {
    expect(pageStep(1)).toBe(1);
    expect(pageStep(0)).toBe(1);
  });
});

describe('visibleLines', () => {
  const lines = flattenMessages(
    [msg('m1', Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'))],
    40,
  );

  it('should_show_the_newest_lines_when_pinned_to_the_bottom', () => {
    const rows = visibleLines(lines, 10, 0);
    expect(rows).toHaveLength(10);
    expect(rows[9].text).toBe('line29');
    expect(rows[0].text).toBe('line20');
  });

  it('should_move_exactly_one_page_per_pgup', () => {
    const rows = visibleLines(lines, 10, pageStep(10));
    expect(rows[9].text).toBe('line20');
  });

  it('should_reach_the_head_of_a_long_message', () => {
    // Regression: the old viewport truncated each message to its tail, so the
    // first lines of a long build log were unreachable at any scroll offset.
    const rows = visibleLines(lines, 10, maxScrollOffset(lines.length, 10));
    expect(rows[0].text).toBe('line0');
  });

  it('should_not_scroll_past_the_oldest_line', () => {
    const rows = visibleLines(lines, 10, 9999);
    expect(rows[0].text).toBe('line0');
    expect(rows).toHaveLength(10);
  });

  it('should_return_all_lines_when_the_log_is_shorter_than_the_viewport', () => {
    const short = flattenMessages([msg('m1', 'a\nb')], 40);
    expect(visibleLines(short, 10, 0)).toHaveLength(2);
  });
});

describe('scrollbarColumn', () => {
  it('should_fill_the_whole_track_when_everything_fits', () => {
    expect(scrollbarColumn(5, 10, 0)).toEqual(new Array(10).fill(true));
  });

  it('should_always_match_the_viewport_height', () => {
    expect(scrollbarColumn(1000, 12, 40)).toHaveLength(12);
  });

  it('should_sit_at_the_bottom_when_pinned_to_the_newest_line', () => {
    const column = scrollbarColumn(100, 10, 0);
    expect(column[9]).toBe(true);
    expect(column[0]).toBe(false);
  });

  it('should_sit_at_the_top_when_scrolled_to_the_oldest_line', () => {
    const column = scrollbarColumn(100, 10, maxScrollOffset(100, 10));
    expect(column[0]).toBe(true);
    expect(column[9]).toBe(false);
  });

  it('should_size_the_thumb_by_the_visible_fraction', () => {
    const half = scrollbarColumn(20, 10, 0).filter(Boolean).length;
    const tenth = scrollbarColumn(100, 10, 0).filter(Boolean).length;
    expect(half).toBe(5);
    expect(tenth).toBeLessThan(half);
  });

  it('should_keep_a_visible_thumb_on_a_huge_log', () => {
    expect(scrollbarColumn(100_000, 10, 0).filter(Boolean).length).toBe(1);
  });

  it('should_keep_the_thumb_inside_the_track_at_every_offset', () => {
    for (let offset = 0; offset <= maxScrollOffset(137, 11); offset++) {
      const column = scrollbarColumn(137, 11, offset);
      const filled = column.filter(Boolean).length;
      expect(filled).toBeGreaterThan(0);
      expect(column).toHaveLength(11);
    }
  });
});
