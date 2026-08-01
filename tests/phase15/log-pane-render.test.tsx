/**
 * Phase 15 — LogPane render.
 *
 * The pure viewport maths cannot show that the pane is actually bordered, holds
 * its height, and draws a scrollbar — the things that were asked for and that a
 * single overwritten status line never had. This renders it at a known terminal
 * size and checks the frame.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

const TERM_COLS = 60;

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useStdout: () => ({ stdout: { rows: 30, columns: TERM_COLS }, write: () => {} }),
    useInput: () => {},
  };
});

const { LogPane } = await import('../../src/components/LogPane.js');
const { logViewport, LOG_PANE_HEIGHT } = await import('../../src/utils/logViewport.js');

const steps = (count: number) =>
  Array.from({ length: count }, (_, i) => `step ${i + 1} doing work`);

describe('LogPane', () => {
  it('should_render_nothing_when_no_line_has_been_logged', () => {
    // An idle settings screen must not spend rows on an empty box.
    const { lastFrame } = render(<LogPane view={logViewport([], 40)} />);
    expect(lastFrame()).toBe('');
  });

  it('should_draw_a_border_and_a_scrollbar_around_the_log', () => {
    const { lastFrame } = render(<LogPane view={logViewport(steps(8), 40)} title="Fetch log" />);
    const frame = lastFrame()!;

    expect(frame).toContain('Fetch log');
    expect(frame).toMatch(/[╭┌]/);
    expect(frame).toMatch(/[╰└]/);
    // Thumb and track are what make it read as scrollable.
    expect(frame).toMatch(/[█░]/);
  });

  it('should_show_exactly_three_log_rows_between_the_borders', () => {
    const { lastFrame } = render(<LogPane view={logViewport(steps(8), 40)} />);
    const rows = lastFrame()!.split('\n');
    const top = rows.findIndex((row) => /[╭┌]/.test(row));
    const bottom = rows.findIndex((row) => /[╰└]/.test(row));

    expect(bottom - top - 1).toBe(LOG_PANE_HEIGHT);
  });

  it('should_show_the_newest_lines_and_offer_pgup_when_pinned_to_the_bottom', () => {
    const { lastFrame } = render(<LogPane view={logViewport(steps(8), 40)} />);
    const frame = lastFrame()!;

    expect(frame).toContain('step 8');
    expect(frame).not.toContain('step 1 ');
    expect(frame).toContain('older (PgUp)');
  });

  it('should_offer_pgdn_back_to_the_latest_when_scrolled_back', () => {
    const { lastFrame } = render(<LogPane view={logViewport(steps(8), 40, LOG_PANE_HEIGHT, 3)} />);
    const frame = lastFrame()!;

    expect(frame).toContain('step 3');
    expect(frame).not.toContain('step 8');
    expect(frame).toContain('PgDn for latest');
  });

  it('should_keep_its_height_when_a_single_entry_is_longer_than_the_terminal', () => {
    // A wrapped 200-character error must not stretch the pane and push the menu
    // above it off screen.
    const { lastFrame } = render(<LogPane view={logViewport(['x'.repeat(200)], 40)} />);
    const rows = lastFrame()!.split('\n');
    const top = rows.findIndex((row) => /[╭┌]/.test(row));
    const bottom = rows.findIndex((row) => /[╰└]/.test(row));

    expect(bottom - top - 1).toBe(LOG_PANE_HEIGHT);
  });
});
