/**
 * Phase 15 — shared invoice-fetcher activity log.
 *
 * The settings screen kept its progress lines in component state, so only the
 * "Fetch now" button could ever fill it. Scheduled runs happen with no screen
 * mounted: "Last run" and "Next run" advanced while the pane below them stayed
 * empty. The log therefore lives outside React and buffers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appendBillerActivity,
  clearBillerActivity,
  getBillerActivity,
  subscribeBillerActivity,
} from '../../src/services/billers/billerActivityLog.js';

describe('billerActivityLog', () => {
  beforeEach(() => clearBillerActivity());

  it('should_retain_lines_written_while_no_screen_is_listening', () => {
    // Nothing subscribed — this is the scheduled-run case.
    appendBillerActivity('Scheduled fetch started 10:00:00');
    appendBillerActivity('[zomato] fetching invoices…');

    // A screen opening afterwards still sees the history.
    expect(getBillerActivity()).toEqual([
      'Scheduled fetch started 10:00:00',
      '[zomato] fetching invoices…',
    ]);
  });

  it('should_notify_subscribers_on_append', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBillerActivity(listener);

    appendBillerActivity('one');
    appendBillerActivity('two');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    appendBillerActivity('three');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('should_change_snapshot_identity_so_react_re_renders', () => {
    // useSyncExternalStore compares by identity; mutating in place would leave
    // the pane frozen on stale content.
    const before = getBillerActivity();
    appendBillerActivity('line');
    expect(getBillerActivity()).not.toBe(before);
  });

  it('should_cap_retained_lines_so_a_long_session_cannot_grow_forever', () => {
    for (let i = 0; i < 600; i++) appendBillerActivity(`line ${i}`);
    const lines = getBillerActivity();

    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe('line 100');
    expect(lines[lines.length - 1]).toBe('line 599');
  });
});
