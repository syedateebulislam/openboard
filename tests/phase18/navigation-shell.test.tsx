/**
 * Phase 18 — navigation shape and the shared screen shell.
 *
 * Two complaints drove this. Invoice fetching lived under Settings, which
 * framed a primary way of getting data into OpenBoard as a preference. And the
 * screens had each grown their own header, footer and phrasing — nine different
 * sentences for "press escape to go back" — so the TUI read as several
 * applications stitched together.
 *
 * These tests pin the structure rather than the prose: menu order, where each
 * row leads, and that hints come from one vocabulary. The line-budget test at
 * the end is the "too much text" complaint stated as an assertion.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return { ...actual, useStdout: () => ({ stdout: { rows: 40, columns: 100 }, write: () => {} }), useInput: () => {} };
});

// ink-select-input drives raw mode through its own resolved ink, which the
// testing library's fake stdin does not implement (`stdin.ref is not a
// function`). It is swapped for a plain renderer: every assertion here is about
// what a screen draws and where its rows lead, and where they lead is asserted
// against the navigation graph rather than by simulating keystrokes — the same
// call this repo already made in the Biller Studio render tests.
vi.mock('ink-select-input', async () => {
  const { Text, Box } = await vi.importActual<typeof import('ink')>('ink');
  return {
    default: ({ items }: { items: Array<{ label: string; value: string }> }) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        items.map((item, index) =>
          React.createElement(Text, { key: item.value }, `${index === 0 ? '❯ ' : '  '}${item.label}`),
        ),
      ),
  };
});

const { WelcomeScreen } = await import('../../src/screens/WelcomeScreen.js');
const { IntegrationsScreen } = await import('../../src/screens/IntegrationsScreen.js');
const { GmailIntegrationScreen } = await import('../../src/screens/GmailIntegrationScreen.js');
const { ScreenFrame, statusTone } = await import('../../src/components/ScreenFrame.js');
const { HintBar, HINTS } = await import('../../src/components/HintBar.js');
const { NAV_PARENT, parentOf } = await import('../../src/config/navigation.js');

let configDir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OPENBOARD_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), 'openboard-nav-'));
  process.env.OPENBOARD_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENBOARD_CONFIG_DIR;
  else process.env.OPENBOARD_CONFIG_DIR = previous;
  rmSync(configDir, { recursive: true, force: true });
});

/** Row order as rendered, ignoring the cursor glyph and indentation. */
function rowsOf(frame: string, labels: string[]): string[] {
  return frame
    .split('\n')
    .map((line) => line.replace(/^[\s❯>]*/, '').trim())
    .filter((line) => labels.some((label) => line.startsWith(label)));
}

// ── main menu ────────────────────────────────────────────────────────────────

describe('main menu', () => {
  it('lists Onboarding, Integrations, Dashboards, Settings in that order', () => {
    const { lastFrame } = render(<WelcomeScreen onNavigate={() => {}} />);
    const order = rowsOf(lastFrame() ?? '', ['Onboarding', 'Integrations', 'Dashboards', 'Settings', 'Exit'])
      .map((row) => row.split(/\s+—\s+/)[0]);
    expect(order).toEqual(['Onboarding', 'Integrations', 'Dashboards', 'Settings', 'Exit']);
  });

  it('calls the first item Onboarding, not Setup', () => {
    const frame = render(<WelcomeScreen onNavigate={() => {}} />).lastFrame() ?? '';
    expect(frame).toContain('Onboarding');
    expect(frame).not.toMatch(/^\s*[❯>]?\s*Setup\s*$/m);
  });

  it('keeps the banner on the entry screen', () => {
    expect(render(<WelcomeScreen onNavigate={() => {}} />).lastFrame() ?? '').toContain('O p e n B o a r d');
  });
});

// ── integrations ─────────────────────────────────────────────────────────────

describe('Integrations', () => {
  it('offers Gmail as a source', () => {
    const frame = render(<IntegrationsScreen onNavigate={() => {}} />).lastFrame() ?? '';
    expect(frame).toContain('Integrations');
    expect(frame).toContain('Gmail');
  });

  it('says Gmail is not connected before credentials exist', () => {
    expect(render(<IntegrationsScreen onNavigate={() => {}} />).lastFrame() ?? '').toMatch(/not connected/i);
  });
});

// ── the hierarchy the user asked for ─────────────────────────────────────────

describe('navigation graph', () => {
  it('hangs Gmail off Integrations, not Settings', () => {
    expect(parentOf('integrations-gmail')).toBe('integrations');
    expect(parentOf('integrations')).toBe('welcome');
  });

  it('returns Biller Studio to the Gmail screen it was opened from', () => {
    expect(parentOf('biller-studio')).toBe('integrations-gmail');
  });

  it('keeps every settings page under Settings', () => {
    for (const screen of Object.keys(NAV_PARENT) as Array<keyof typeof NAV_PARENT>) {
      if (screen.startsWith('settings-')) expect(parentOf(screen), screen).toBe('settings');
    }
  });

  it('has no screen parented to a biller settings page that no longer exists', () => {
    expect(Object.values(NAV_PARENT)).not.toContain('settings-billers');
  });

  it('falls back to the main menu for anything unmapped', () => {
    expect(parentOf('chat')).toBe('welcome');
  });
});

describe('Gmail integration screen', () => {
  it('is titled under Integrations, not Settings', () => {
    const frame = render(<GmailIntegrationScreen onNavigate={() => {}} />).lastFrame() ?? '';
    expect(frame).toContain('Integrations');
    expect(frame).toContain('Gmail');
    // The old name framed this as a settings page for scripts.
    expect(frame).not.toContain('Invoice Fetchers');
  });

  it('spends few lines before the first option', () => {
    // The complaint, as an assertion: this screen used to render a title, a
    // two-line subtitle, up to five status lines and a four-line paragraph —
    // twelve lines of chrome — before anything selectable.
    const frame = render(<GmailIntegrationScreen onNavigate={() => {}} />).lastFrame() ?? '';
    const lines = frame.split('\n');
    // The cursor marks the first selectable row.
    const firstOption = lines.findIndex((line) => line.includes('❯'));
    expect(firstOption).toBeGreaterThan(-1);
    // Title, meta, blank. Twelve lines of chrome became three.
    expect(firstOption, frame).toBeLessThanOrEqual(4);
  });

  it('does not keep the security paragraph permanently on screen', () => {
    // It is still available — '?' expands it, and the App Password row carries
    // it — but it is not four standing lines of noise.
    const frame = render(<GmailIntegrationScreen onNavigate={() => {}} />).lastFrame() ?? '';
    expect(frame).not.toMatch(/grants full mailbox read access/i);
  });
});

// ── one hint vocabulary ──────────────────────────────────────────────────────

describe('HintBar', () => {
  it('renders the canonical wording, joined', () => {
    const frame = render(<HintBar keys={['move', 'select', 'back']} />).lastFrame() ?? '';
    expect(frame).toContain(HINTS.move);
    expect(frame).toContain(HINTS.select);
    expect(frame).toContain(HINTS.back);
  });

  it('is the only place "go back" is worded', () => {
    // Nine variants had accumulated. Any screen inventing a tenth reintroduces
    // exactly the inconsistency this replaced.
    expect(HINTS.back).toBe('esc back');
  });
});

describe('screens use the shared vocabulary rather than their own sentences', async () => {
  // readdirSync, not fs.globSync: glob landed in Node 22 and CI runs 18 and 20,
  // so globSync passed locally and failed everywhere that matters.
  const { readFileSync, readdirSync } = await import('node:fs');

  it('no screen still spells out its own escape hint', () => {
    const files = readdirSync('src/screens')
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => `src/screens/${name}`)
      .concat(['src/App.tsx']);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      // Prose hints rendered to the user, not comments or chat copy.
      for (const match of source.matchAll(/<Text[^>]*>\s*\{?['"`]?[^<]*?(Press ESC|ESC to go back|↑↓ arrows|Use ↑\/↓)[^<]*?<\/Text>/g)) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── frame behaviour ──────────────────────────────────────────────────────────

describe('ScreenFrame', () => {
  it('renders a breadcrumb from segments', () => {
    const frame = render(
      <ScreenFrame title={['Integrations', 'Gmail']} hints={['back']}><></></ScreenFrame>,
    ).lastFrame() ?? '';
    expect(frame).toMatch(/Integrations\s*›\s*Gmail/);
  });

  it('joins meta facts onto one line and drops the absent ones', () => {
    const frame = render(
      <ScreenFrame title="X" meta={['ready', false, undefined, '3 on']} hints={['back']}><></></ScreenFrame>,
    ).lastFrame() ?? '';
    const metaLine = frame.split('\n').find((line) => line.includes('ready'))!;
    expect(metaLine).toContain('3 on');
    expect(metaLine).not.toMatch(/undefined|false/);
  });

  it('reserves the detail row so the cursor moving does not shift the layout', () => {
    const withDetail = render(
      <ScreenFrame title="X" detail="something" hints={['back']}><></></ScreenFrame>,
    ).lastFrame()!.split('\n').length;
    const without = render(
      <ScreenFrame title="X" hints={['back']}><></></ScreenFrame>,
    ).lastFrame()!.split('\n').length;
    expect(withDetail).toBe(without);
  });
});

describe('statusTone', () => {
  it('reads failure wording as an error', () => {
    for (const message of ['Could not save', 'Invalid token', 'Password must be 8', 'No dashboards found']) {
      expect(statusTone(message), message).toBe('error');
    }
  });

  it('reads success as success', () => {
    expect(statusTone('App Password saved (encrypted).')).toBe('ok');
  });

  it('lets an in-flight action win over the wording', () => {
    expect(statusTone('Validating LLM settings...', true)).toBe('busy');
  });
});
