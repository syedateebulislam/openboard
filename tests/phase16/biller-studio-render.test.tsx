/**
 * Phase 16 — Biller Studio: stage machine + rendered frame.
 *
 * The stage machine is tested through billerStudioFlow rather than by driving
 * a rendered TUI. ink-text-input needs the real useInput, and ink-testing-
 * library's fake stdin lacks the ref/unref that useInput calls on mount, so
 * keystroke-level tests here assert more about the harness than the feature.
 * The decisions worth pinning — above all that a real receipt is never sent
 * without an explicit yes — are pure, so they are asserted directly.
 *
 * The render block below covers what only rendering can show: that the window
 * is branded for this feature and opens on the right question.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { HINTS } from '../../src/components/HintBar.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAffirmative,
  nextStudioAction,
  SENDER_PATTERN,
  type StudioStage,
} from '../../src/screens/billerStudioFlow.js';

const TERM_COLS = 80;

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useStdout: () => ({ stdout: { rows: 40, columns: TERM_COLS }, write: () => {} }),
    useInput: () => {},
  };
});

// ink-text-input resolves its own copy of ink, so the mock above never reaches
// it — it calls the real useInput, which calls stdin.ref(), which the testing
// library's fake stdin does not implement. Swap it for an inert placeholder:
// every assertion below is about chrome the screen draws itself.
vi.mock('ink-text-input', async () => {
  const { Text } = await vi.importActual<typeof import('ink')>('ink');
  return {
    default: ({ value, placeholder }: { value?: string; placeholder?: string }) =>
      React.createElement(Text, null, value || placeholder || ''),
  };
});

const { BillerStudioScreen } = await import('../../src/screens/BillerStudioScreen.js');
const { BillerProbeService } = await import('../../src/services/billers/BillerProbeService.js');

// ── stage machine ────────────────────────────────────────────────────────────

describe('studio stage machine', () => {
  it('accepts a plausible sender address', () => {
    expect(nextStudioAction('sender', 'noreply@bigbasket.com')).toEqual({
      type: 'accept-sender',
      sender: 'noreply@bigbasket.com',
    });
  });

  it('rejects input that is not an address, without advancing', () => {
    const action = nextStudioAction('sender', 'bigbasket');
    expect(action.type).toBe('reject-sender');
    expect(action).toHaveProperty('message', expect.stringMatching(/not an email address/i));
  });

  it('treats "-" as match-every-subject', () => {
    expect(nextStudioAction('subject', '-')).toEqual({ type: 'accept-subject', subject: '' });
  });

  it('keeps a real subject fragment verbatim, including spaces', () => {
    expect(nextStudioAction('subject', 'Your order from')).toEqual({
      type: 'accept-subject',
      subject: 'Your order from',
    });
  });

  describe('consent to transmit the sample', () => {
    it('sends only on an explicit yes', () => {
      expect(nextStudioAction('confirm-send', 'yes').type).toBe('send-sample');
      expect(nextStudioAction('confirm-send', 'y').type).toBe('send-sample');
      expect(nextStudioAction('confirm-send', 'YES').type).toBe('send-sample');
    });

    it('declines on anything else at all', () => {
      // A typo, a stray keypress or an ambiguous answer must never be read as
      // consent — this is a real receipt leaving the machine.
      for (const answer of ['no', 'n', 'ok', 'sure', 'yes please', 'yep', 'Y E S', '1', 'yeah']) {
        expect(nextStudioAction('confirm-send', answer).type).toBe('decline-sample');
      }
    });
  });

  it('builds only on an explicit yes', () => {
    expect(nextStudioAction('confirm-fields', 'yes').type).toBe('build');
    expect(nextStudioAction('confirm-fields', 'maybe').type).toBe('decline-build');
  });

  it('honours commands from every stage, so no stage can trap the user', () => {
    const stages: StudioStage[] = ['sender', 'subject', 'working', 'confirm-send', 'confirm-fields', 'done'];
    for (const stage of stages) {
      expect(nextStudioAction(stage, '/cancel').type).toBe('leave');
      expect(nextStudioAction(stage, '/help').type).toBe('help');
      expect(nextStudioAction(stage, '/restart').type).toBe('restart');
    }
  });

  it('does not mistake a command for consent', () => {
    // /cancel at a confirmation prompt must leave, not decline-and-continue.
    expect(nextStudioAction('confirm-send', '/cancel').type).toBe('leave');
  });

  it('ignores empty input', () => {
    expect(nextStudioAction('sender', '   ').type).toBe('noop');
  });

  it('gives a hint rather than acting once finished', () => {
    expect(nextStudioAction('done', 'hello').type).toBe('idle-hint');
    expect(nextStudioAction('working', 'hello').type).toBe('idle-hint');
  });

  it('is case-insensitive about commands', () => {
    expect(nextStudioAction('sender', '/CANCEL').type).toBe('leave');
  });
});

describe('isAffirmative', () => {
  it('accepts only yes and y, trimmed and case-insensitive', () => {
    expect(isAffirmative('  Yes ')).toBe(true);
    expect(isAffirmative('Y')).toBe(true);
    expect(isAffirmative('yess')).toBe(false);
    expect(isAffirmative('')).toBe(false);
  });
});

describe('SENDER_PATTERN', () => {
  it('accepts the address shapes billers actually use', () => {
    for (const address of ['noreply@zomato.com', 'no-reply@amazonpay.in', 'partner@rapido.bike', 'a.b+c@sub.domain.co.uk']) {
      expect(SENDER_PATTERN.test(address)).toBe(true);
    }
  });

  it('rejects obvious non-addresses', () => {
    for (const bad of ['zomato', 'zomato.com', '@zomato.com', 'a@b', 'a b@c.com']) {
      expect(SENDER_PATTERN.test(bad)).toBe(false);
    }
  });
});

// ── rendered frame ───────────────────────────────────────────────────────────

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.OPENBOARD_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), 'openboard-studio-render-'));
  process.env.OPENBOARD_CONFIG_DIR = configDir;
  mkdirSync(join(configDir, 'billers', 'scripts', 'invoice_fetchers'), { recursive: true });
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.OPENBOARD_CONFIG_DIR;
  else process.env.OPENBOARD_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe('BillerStudioScreen frame', () => {
  const probe = () =>
    new BillerProbeService({
      runProbe: async () => JSON.stringify({ matched: 0, scanned: 0, sample: null, otherSubjects: [], sinceDate: '' }),
    });

  it('is branded for creating billers, not for dashboards', () => {
    const { lastFrame } = render(
      <BillerStudioScreen onNavigate={() => {}} deps={{ probeService: probe() }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Biller Studio');
    expect(frame).toMatch(/invoice source/i);
    // The dashboard chat's framing must not leak into this window.
    expect(frame).not.toMatch(/create or modify this dashboard/i);
  });

  it('opens by asking for the sender address, with an example', () => {
    const { lastFrame } = render(
      <BillerStudioScreen onNavigate={() => {}} deps={{ probeService: probe() }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Sender address/);
    expect(frame).toMatch(/noreply@/);
  });

  it('offers its own footer affordances', () => {
    const { lastFrame } = render(
      <BillerStudioScreen onNavigate={() => {}} deps={{ probeService: probe() }} />,
    );
    // Sourced from HINTS rather than typed here, so the assertion tracks the
    // shared vocabulary instead of freezing one screen's old phrasing.
    expect(lastFrame() ?? '').toContain(HINTS.back);
  });
});
