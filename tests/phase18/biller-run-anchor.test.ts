/**
 * Phase 18 — anchoring a fetch, and stopping one.
 *
 * A nine-biller fetch takes minutes. The schedule used to anchor only when the
 * run finished AND the scheduler was still live, so anything that ended the run
 * in between — quitting the TUI, a re-armed scheduler — threw away the anchor
 * for work that had already happened. lastRunAt stayed put, the next launch saw
 * an overdue schedule, and everything was fetched again. Observed in the wild:
 * lastRunAt sat at 03:46 while runs kept starting hours later.
 *
 * The run is also stoppable now, so a wedged fetcher no longer means killing
 * the terminal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startBillerScheduler } from '../../src/services/billers/billerScheduler.js';
import {
  activeBillerRun,
  beginBillerRun,
  endBillerRun,
  stopBillerRun,
} from '../../src/services/billers/billerRunController.js';

const OVERDUE = () => ({
  scriptsDir: 'C:/scripts',
  email: 'a@b.com',
  appPassword: 'secret',
  enabledKeys: ['zomato'],
  syncIntervalMinutes: 360,
  lastRunAt: new Date(Date.now() - 400 * 60_000).toISOString(),
}) as any;

const result = (ok = true) => ({ key: 'zomato', displayName: 'Zomato', ok, changed: false });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A fetcher whose run can be held open, like a real multi-biller fetch. */
function heldFetcher() {
  let release!: (rows: any[]) => void;
  const gate = new Promise<any[]>((resolve) => { release = resolve; });
  let started: (() => void) | undefined;
  const fetcher = {
    syncEnabled: vi.fn(async (options: any) => {
      started = options.onStart;
      options.onStart?.();
      return gate;
    }),
  };
  return { fetcher: fetcher as any, release, calls: () => fetcher.syncEnabled.mock.calls, startedFired: () => Boolean(started) };
}

beforeEach(() => {
  // The controller is module state; a leftover run would mask a real one.
  const leftover = activeBillerRun();
  if (leftover) endBillerRun(leftover);
});

// ── anchoring ────────────────────────────────────────────────────────────────

describe('a scheduled run anchors the schedule', () => {
  it('anchors as soon as the fetch starts, not when it ends', async () => {
    const recorded: string[] = [];
    const { fetcher, release } = heldFetcher();

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();

    // Still mid-fetch, yet the schedule already knows this run happened.
    expect(recorded).toHaveLength(1);

    release([result()]);
    await settle();
    // And it does not double-anchor on completion.
    expect(recorded).toHaveLength(1);
    stop();
  });

  it('keeps the anchor when the scheduler is stopped mid-fetch', async () => {
    // The regression: quitting the TUI or re-arming the scheduler during a run
    // discarded the anchor, so the next launch refetched everything — forever.
    const recorded: string[] = [];
    const { fetcher, release } = heldFetcher();

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();
    stop();
    release([result()]);
    await settle();

    expect(recorded).toHaveLength(1);
  });

  it('still anchors a fetcher that never signals its start', async () => {
    // Anchoring must not depend on a callback being wired: forgetting it would
    // leave the schedule permanently overdue, the very bug being fixed.
    const recorded: string[] = [];
    const fetcher = { syncEnabled: vi.fn(async () => [result()]) } as any;

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();

    expect(recorded).toHaveLength(1);
    stop();
  });

  it('does not anchor when no fetcher ran', async () => {
    // Stamping the schedule for work that never happened pushed the next run
    // out a full interval and quietly suppressed the loop.
    const recorded: string[] = [];
    const fetcher = { syncEnabled: vi.fn(async () => []) } as any;

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();

    expect(recorded).toEqual([]);
    stop();
  });

  it('does not anchor a run the lock turned away', async () => {
    const recorded: string[] = [];
    const locked: any = [];
    Object.defineProperty(locked, 'skipped', { value: 'locked' });
    const fetcher = { syncEnabled: vi.fn(async () => locked) } as any;

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();

    expect(recorded).toEqual([]);
    stop();
  });

  it('anchors on the start time, so the interval does not drift by the fetch length', async () => {
    const recorded: string[] = [];
    const { fetcher, release } = heldFetcher();
    const before = Date.now();

    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: (t) => recorded.push(t), onProgress: () => {},
    });
    await settle();
    release([result()]);
    await settle();

    expect(Date.parse(recorded[0])).toBeGreaterThanOrEqual(before);
    expect(Date.parse(recorded[0])).toBeLessThanOrEqual(Date.now());
    stop();
  });
});

// ── stopping ─────────────────────────────────────────────────────────────────

describe('stopping a run', () => {
  it('reports nothing to stop when idle, rather than claiming success', () => {
    expect(stopBillerRun()).toBeUndefined();
  });

  it('aborts the signal the fetch is watching', () => {
    const run = beginBillerRun('manual');
    expect(run.controller.signal.aborted).toBe(false);
    stopBillerRun();
    expect(run.controller.signal.aborted).toBe(true);
  });

  it('can stop a scheduled run the screen did not start', async () => {
    // The point of a shared handle: a wedged scheduled fetch was previously
    // only reachable by killing the terminal.
    const { fetcher, release } = heldFetcher();
    const stop = startBillerScheduler(() => {}, {
      fetcher, settings: OVERDUE, recordRun: () => {}, onProgress: () => {},
    });
    await settle();

    const running = activeBillerRun();
    expect(running?.origin).toBe('scheduled');

    const stopped = stopBillerRun();
    expect(stopped?.origin).toBe('scheduled');
    expect(running!.controller.signal.aborted).toBe(true);

    release([result()]);
    await settle();
    stop();
  });

  it('reports what was stopped so the message can name it', () => {
    beginBillerRun('manual');
    expect(stopBillerRun()?.origin).toBe('manual');
  });

  it('clears the active run once stopped', () => {
    beginBillerRun('manual');
    stopBillerRun();
    expect(activeBillerRun()).toBeUndefined();
  });

  it('a late finisher does not deregister the run that replaced it', () => {
    // Otherwise the screen offers to stop a fetch that has ended while the real
    // one runs on unreachable.
    const first = beginBillerRun('scheduled');
    const second = beginBillerRun('manual');
    endBillerRun(first);
    expect(activeBillerRun()).toBe(second);
    endBillerRun(second);
  });
});
