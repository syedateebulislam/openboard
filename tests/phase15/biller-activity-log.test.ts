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

  it('should_batch_subscriber_notifications_for_one_progress_burst', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBillerActivity(listener);

    appendBillerActivity('one');
    appendBillerActivity('two');
    // Both lines are visible immediately, but React only needs one notification
    // after the current stream chunk has finished.
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    appendBillerActivity('three');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
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

  it('should_notify_once_when_a_dashboard_build_streams_many_lines', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBillerActivity(listener);

    for (let i = 0; i < 600; i++) appendBillerActivity(`codex: line ${i}`);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
