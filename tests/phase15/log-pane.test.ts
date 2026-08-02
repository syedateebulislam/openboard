/**
 * Phase 15 — progress log viewport.
 *
 * The menu screens bound their onProgress callback to a single string that each
 * new line overwrote, so a long-running removal or invoice fetch showed one
 * flickering line and no history. These tests pin the fixed-height, scrollable
 * replacement: pure maths, no terminal.
 */

import { describe, it, expect } from 'vitest';
import { MAX_VIEW_LINES } from '../../src/utils/chatViewport.js';
import {
  LOG_PANE_HEIGHT,
  flattenLogLines,
  logViewport,
} from '../../src/utils/logViewport.js';

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

describe('flattenLogLines', () => {
  it('should_keep_one_line_per_entry_when_everything_fits', () => {
    expect(flattenLogLines(['alpha', 'beta'], 40)).toEqual(['alpha', 'beta']);
  });

  it('should_expand_one_entry_into_several_lines_when_it_wraps', () => {
    // A single long entry must count as the rows it really occupies, or it
    // would silently push the rest of a 3-row window off screen.
    expect(flattenLogLines(['aaa bbb ccc ddd'], 7)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('should_drop_the_oldest_lines_when_the_scrollback_cap_is_hit', () => {
    const flat = flattenLogLines(lines(MAX_VIEW_LINES + 10), 40);
    expect(flat).toHaveLength(MAX_VIEW_LINES);
    expect(flat[0]).toBe('line11');
    expect(flat[flat.length - 1]).toBe(`line${MAX_VIEW_LINES + 10}`);
  });
});

/** The newest `count` of `lines(total)`, so expectations track LOG_PANE_HEIGHT. */
const newest = (total: number, count = LOG_PANE_HEIGHT) =>
  lines(total).slice(-count);

/** The oldest `count`, for the clamped-past-the-top case. */
const oldest = (total: number, count = LOG_PANE_HEIGHT) =>
  lines(total).slice(0, count);

describe('logViewport', () => {
  it('should_show_the_newest_lines_when_pinned_to_the_bottom', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, 0);
    expect(view.rows).toEqual(newest(10));
    expect(view.hiddenOlder).toBe(10 - LOG_PANE_HEIGHT);
    expect(view.hiddenNewer).toBe(0);
  });

  it('should_show_the_previous_page_when_scrolled_back', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, 3);
    expect(view.rows).toEqual(lines(10).slice(-LOG_PANE_HEIGHT - 3, -3));
    expect(view.hiddenOlder).toBe(10 - LOG_PANE_HEIGHT - 3);
    expect(view.hiddenNewer).toBe(3);
  });

  it('should_still_fill_the_window_when_a_single_entry_wraps', () => {
    // One entry long enough to wrap past the window: the pane counts wrapped
    // lines, not entries, so it fills and reports the overflow above.
    // Sized from LOG_PANE_HEIGHT so this keeps testing overflow if the pane
    // height changes again.
    const words = Array.from({ length: LOG_PANE_HEIGHT + 1 }, (_, i) => `w${i}`);
    const view = logViewport([words.join(' ')], 2, LOG_PANE_HEIGHT, 0);

    expect(view.rows).toHaveLength(LOG_PANE_HEIGHT);
    expect(view.rows).toEqual(words.slice(-LOG_PANE_HEIGHT));
    expect(view.hiddenOlder).toBe(1);
  });

  it('should_render_fewer_rows_than_the_height_when_the_log_is_short', () => {
    const view = logViewport(['only one'], 40, LOG_PANE_HEIGHT, 0);
    expect(view.rows).toEqual(['only one']);
    expect(view.hiddenOlder).toBe(0);
    expect(view.hiddenNewer).toBe(0);
  });

  it('should_report_an_empty_viewport_when_nothing_has_been_logged', () => {
    // The pane keys "render nothing at all" off this, so an idle screen spends
    // no rows on an empty box.
    expect(logViewport([], 40).totalLines).toBe(0);
  });

  it('should_clamp_an_offset_past_the_top_instead_of_running_off_the_log', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, 999);
    expect(view.rows).toEqual(oldest(10));
    expect(view.hiddenOlder).toBe(0);
    expect(view.hiddenNewer).toBe(10 - LOG_PANE_HEIGHT);
  });

  it('should_clamp_a_negative_offset_back_to_the_newest_line', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, -5);
    expect(view.rows).toEqual(newest(10));
    expect(view.hiddenNewer).toBe(0);
  });

  it('should_fill_the_scrollbar_when_the_whole_log_already_fits', () => {
    expect(logViewport(lines(2), 40, LOG_PANE_HEIGHT, 0).scrollbar)
      .toEqual(Array(LOG_PANE_HEIGHT).fill(true));
  });

  it('should_size_the_scrollbar_to_the_viewport_when_the_log_is_longer', () => {
    const view = logViewport(lines(30), 40, LOG_PANE_HEIGHT, 0);
    expect(view.scrollbar).toHaveLength(LOG_PANE_HEIGHT);
    // Pinned to the newest line, so the thumb sits at the bottom.
    expect(view.scrollbar[LOG_PANE_HEIGHT - 1]).toBe(true);
    expect(view.scrollbar.filter(Boolean).length).toBeLessThan(LOG_PANE_HEIGHT);
  });
});
