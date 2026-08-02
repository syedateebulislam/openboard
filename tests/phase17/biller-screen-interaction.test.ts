/**
 * Phase 17 — two reported bugs on the invoice fetchers screen.
 *
 * 1. Opening the screen appeared to trigger a fetch. It was not the screen:
 *    arming the scheduler runs an overdue schedule immediately, and the app
 *    re-armed on every settings change — so once the schedule was due, toggling
 *    a biller started a full fetch.
 * 2. Space did nothing on a biller row. ink-select-input binds only arrows,
 *    j/k and Enter, so the most obvious key for a checkbox was never wired.
 */

import { describe, it, expect } from 'vitest';
import type { BillerSettings } from '../../src/types/billers.js';
import { billerSchedulerArmKey, msUntilDue } from '../../src/services/billers/billerScheduler.js';
import { billerKeyForToggle } from '../../src/screens/BillerSettingsScreen.js';

const settings = (overrides: Partial<BillerSettings> = {}): BillerSettings => ({
  scriptsDir: '/scripts/invoice_fetchers',
  email: 'user@gmail.com',
  appPassword: 'abcdefghijklmnop',
  enabledKeys: ['zomato'],
  syncIntervalMinutes: 60,
  sinceDays: 30,
  ...overrides,
});

describe('scheduler arm key', () => {
  it('does not change when a biller is toggled', () => {
    // The bug: this changed on every settings write, the app re-armed, and an
    // overdue schedule fired at once — so switching a biller on started a fetch.
    const before = billerSchedulerArmKey(settings({ enabledKeys: ['zomato'] }));
    const after = billerSchedulerArmKey(settings({ enabledKeys: ['zomato', 'uber_rides'] }));
    expect(after).toBe(before);
  });

  it('does not change when the address or password is replaced', () => {
    // A running loop re-reads both on every tick.
    const before = billerSchedulerArmKey(settings());
    expect(billerSchedulerArmKey(settings({ email: 'other@gmail.com' }))).toBe(before);
    expect(billerSchedulerArmKey(settings({ appPassword: 'ponmlkjihgfedcba' }))).toBe(before);
  });

  it('changes when the interval changes, which the loop captured at arm time', () => {
    const before = billerSchedulerArmKey(settings({ syncIntervalMinutes: 60 }));
    expect(billerSchedulerArmKey(settings({ syncIntervalMinutes: 30 }))).not.toBe(before);
  });

  it('changes when the last biller is switched off, and back when one returns', () => {
    // Crossing the configured boundary has to start or stop the loop.
    const running = billerSchedulerArmKey(settings({ enabledKeys: ['zomato'] }));
    const stopped = billerSchedulerArmKey(settings({ enabledKeys: [] }));
    expect(stopped).not.toBe(running);
    expect(billerSchedulerArmKey(settings({ enabledKeys: ['amazon'] }))).toBe(running);
  });

  it('changes when the setup becomes complete', () => {
    const incomplete = billerSchedulerArmKey(settings({ appPassword: undefined }));
    expect(billerSchedulerArmKey(settings())).not.toBe(incomplete);
  });

  it('still reports an overdue schedule as due, so a real launch catches up', () => {
    // The immediate-run behaviour is wanted at startup; the fix was to stop
    // re-arming for changes that never needed it, not to delay a due run.
    const overdue = settings({ lastRunAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
    expect(msUntilDue(overdue)).toBe(0);

    const recent = settings({ lastRunAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect(msUntilDue(recent)).toBeGreaterThan(0);
  });
});

describe('billerKeyForToggle', () => {
  it('reads the key off a biller row', () => {
    expect(billerKeyForToggle('toggle:zomato')).toBe('zomato');
    expect(billerKeyForToggle('toggle:uber_rides')).toBe('uber_rides');
  });

  it('ignores every other menu row, so space does nothing there', () => {
    for (const value of ['install', 'dir', 'email', 'password', 'interval', 'sync', 'rescan', 'clear', 'back', 'add-biller']) {
      expect(billerKeyForToggle(value), value).toBeUndefined();
    }
  });

  it('does not mistake a key that merely contains the prefix', () => {
    expect(billerKeyForToggle('untoggle:zomato')).toBeUndefined();
  });

  it('survives a key containing the separator', () => {
    // slice() on a hardcoded 7 would have been just as correct here, but only
    // by coincidence; this is the reason the offset is derived.
    expect(billerKeyForToggle('toggle:a:b')).toBe('a:b');
  });
});
