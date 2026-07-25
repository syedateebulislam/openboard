/**
 * Phase 12 — Gmail integration: welcome-screen status line formatting.
 */

import { describe, it, expect } from 'vitest';
import { mailStatusLine } from '../../src/screens/WelcomeScreen.js';

describe('mailStatusLine', () => {
  it('is hidden when gmail is not configured or status is unknown', () => {
    expect(mailStatusLine(null)).toBeNull();
    expect(mailStatusLine(undefined)).toBeNull();
    expect(mailStatusLine({ state: 'not-configured' })).toBeNull();
  });

  it('points at settings on needs-reauth', () => {
    expect(mailStatusLine({ state: 'needs-reauth' })).toContain('re-auth needed');
  });

  it('summarizes cache size and sync times when idle', () => {
    const line = mailStatusLine({
      state: 'idle',
      totalCached: 1240,
      lastSyncAt: '2026-07-15T09:30:00.000Z',
      nextSyncAt: '2026-07-15T09:35:00.000Z',
    });
    expect(line).toContain('1240 cached');
    expect(line).toContain('last sync');
    expect(line).toContain('next');
  });

  it('shows syncing state and error state', () => {
    expect(mailStatusLine({ state: 'syncing', totalCached: 5 })).toContain('syncing…');
    expect(mailStatusLine({ state: 'error', totalCached: 5, error: 'boom' })).toContain('last sync failed');
  });
});
