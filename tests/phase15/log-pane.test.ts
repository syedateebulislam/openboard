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

describe('logViewport', () => {
  it('should_show_the_newest_three_lines_when_pinned_to_the_bottom', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, 0);
    expect(view.rows).toEqual(['line8', 'line9', 'line10']);
    expect(view.hiddenOlder).toBe(7);
    expect(view.hiddenNewer).toBe(0);
  });

  it('should_show_the_previous_page_when_scrolled_back', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, 3);
    expect(view.rows).toEqual(['line5', 'line6', 'line7']);
    expect(view.hiddenOlder).toBe(4);
    expect(view.hiddenNewer).toBe(3);
  });

  it('should_still_show_exactly_three_rows_when_a_single_entry_wraps', () => {
    // Wraps to four rows, so the 3-row window keeps only the newest three.
    const view = logViewport(['aaa bbb ccc ddd eee fff ggg hhh'], 7, LOG_PANE_HEIGHT, 0);
    expect(view.rows).toHaveLength(LOG_PANE_HEIGHT);
    expect(view.rows).toEqual(['ccc ddd', 'eee fff', 'ggg hhh']);
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
    expect(view.rows).toEqual(['line1', 'line2', 'line3']);
    expect(view.hiddenOlder).toBe(0);
    expect(view.hiddenNewer).toBe(7);
  });

  it('should_clamp_a_negative_offset_back_to_the_newest_line', () => {
    const view = logViewport(lines(10), 40, LOG_PANE_HEIGHT, -5);
    expect(view.rows).toEqual(['line8', 'line9', 'line10']);
    expect(view.hiddenNewer).toBe(0);
  });

  it('should_fill_the_scrollbar_when_the_whole_log_already_fits', () => {
    expect(logViewport(lines(2), 40, LOG_PANE_HEIGHT, 0).scrollbar).toEqual([true, true, true]);
  });

  it('should_size_the_scrollbar_to_the_viewport_when_the_log_is_longer', () => {
    const view = logViewport(lines(30), 40, LOG_PANE_HEIGHT, 0);
    expect(view.scrollbar).toHaveLength(LOG_PANE_HEIGHT);
    // Pinned to the newest line, so the thumb sits at the bottom.
    expect(view.scrollbar[LOG_PANE_HEIGHT - 1]).toBe(true);
    expect(view.scrollbar.filter(Boolean).length).toBeLessThan(LOG_PANE_HEIGHT);
  });
});
