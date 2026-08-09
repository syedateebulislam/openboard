/**
 * Capture every TUI screen as a text frame.
 *
 * The TUI renders ANSI to a terminal, not a DOM, so a browser cannot traverse
 * it and the Playwright suite covers only the generated web app. This is the
 * other half: each screen is rendered and its frame written to
 * `__screens__/tui/`, giving the TUI the same review surface the dashboards get
 * — a per-screen artefact you read, rather than a shape asserted in code.
 *
 * The frames are also asserted, lightly: a screen that renders nothing, loses
 * its title, or forgets its key hints is a defect no reviewer should have to
 * spot by eye.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return { ...actual, useStdout: () => ({ stdout: { rows: 40, columns: 100 }, write: () => {} }), useInput: () => {} };
});

// ink-select-input drives raw mode through its own resolved ink, which the
// testing library's fake stdin does not implement. Swapped for a plain
// renderer: the frames are about what each screen says, and the rows are what
// it says. Matches the approach already used by the other render suites.
vi.mock('ink-select-input', async () => {
  const { Text, Box } = await vi.importActual<typeof import('ink')>('ink');
  return {
    default: ({ items }: { items: Array<{ label: string; value: string }> }) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        items.map((item, index) =>
          React.createElement(Text, { key: item.value }, `${index === 0 ? '>' : ' '} ${item.label}`),
        ),
      ),
  };
});

vi.mock('ink-text-input', async () => {
  const { Text } = await vi.importActual<typeof import('ink')>('ink');
  return { default: ({ value, placeholder }: { value?: string; placeholder?: string }) =>
    React.createElement(Text, {}, value || placeholder || '') };
});

const OUT = join(import.meta.dirname, '..', '__screens__', 'tui');

/** A throwaway config dir, so capturing frames never reads or writes real settings. */
let configDir: string;

beforeAll(async () => {
  configDir = join(tmpdir(), `openboard-frames-${randomUUID().slice(0, 8)}`);
  mkdirSync(configDir, { recursive: true });
  process.env.OPENBOARD_CONFIG_DIR = configDir;
  mkdirSync(OUT, { recursive: true });
});

afterAll(() => {
  if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

async function capture(name: string, element: React.ReactElement): Promise<string> {
  const { render } = await import('ink-testing-library');
  const instance = render(element);
  // Let effects that read config settle before the frame is taken.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const frame = instance.lastFrame() ?? '';
  instance.unmount();
  writeFileSync(join(OUT, `${name}.txt`), frame, 'utf-8');
  return frame;
}

const noop = () => {};

describe('TUI screens render a reviewable frame', () => {
  it('captures the main menu', async () => {
    const { WelcomeScreen } = await import('../../../src/screens/WelcomeScreen.js');
    const frame = await capture('welcome', <WelcomeScreen onNavigate={noop} />);

    // The order you asked for is the order it must render in.
    const order = ['Onboarding', 'Integrations', 'Dashboards', 'Settings', 'Exit'];
    const positions = order.map((label) => frame.indexOf(label));
    expect(positions.every((index) => index >= 0), `menu is missing one of ${order.join(', ')}`).toBe(true);
    expect(positions, 'main menu is out of order').toEqual([...positions].sort((a, b) => a - b));
  });

  it('captures Integrations', async () => {
    const { IntegrationsScreen } = await import('../../../src/screens/IntegrationsScreen.js');
    const frame = await capture('integrations', <IntegrationsScreen onNavigate={noop} />);
    expect(frame).toContain('Gmail');
  });

  it('captures Integrations › Gmail', async () => {
    const { GmailIntegrationScreen } = await import('../../../src/screens/GmailIntegrationScreen.js');
    const frame = await capture('integrations-gmail', <GmailIntegrationScreen onNavigate={noop} />);
    expect(frame).toContain('Gmail');
  });

  it('captures Dashboards', async () => {
    const { ManageBoardsScreen } = await import('../../../src/screens/ManageBoardsScreen.js');
    const frame = await capture('dashboards', (
      <ManageBoardsScreen onNavigate={noop} onBoardSelected={noop} onModifyAll={noop} />
    ));
    expect(frame.length).toBeGreaterThan(0);
  });

  it('captures dashboard creation', async () => {
    const { BoardCreationScreen } = await import('../../../src/screens/BoardCreationScreen.js');
    const frame = await capture('create-dashboard', <BoardCreationScreen onNavigate={noop} onBoardCreated={noop} />);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('captures onboarding', async () => {
    const { SetupWizard } = await import('../../../src/screens/SetupWizard.js');
    const frame = await capture('onboarding', <SetupWizard onComplete={noop} onNavigate={noop} />);
    expect(frame.length).toBeGreaterThan(0);
  });

  it('captures every settings screen', async () => {
    const app = await import('../../../src/App.js');
    const screens: Array<[string, React.ComponentType<{ onNavigate: (s: never) => void }>]> = [
      ['settings', app.SettingsPlaceholder as never],
      ['settings-app-mode', app.AppModeSettings as never],
      ['settings-llm', app.LLMSettings as never],
      ['settings-github', app.GitHubTokenSettings as never],
      ['settings-vercel', app.VercelTokenSettings as never],
      ['settings-dashboard-login', app.DashboardAuthSettings as never],
    ];

    for (const [name, Screen] of screens) {
      const frame = await capture(name, <Screen onNavigate={noop as never} />);
      expect(frame.trim().length, `${name} rendered an empty frame`).toBeGreaterThan(0);
    }
  });
});

describe('the shared shell is actually shared', () => {
  it('gives every menu screen the same hint vocabulary', async () => {
    const { WelcomeScreen } = await import('../../../src/screens/WelcomeScreen.js');
    const { IntegrationsScreen } = await import('../../../src/screens/IntegrationsScreen.js');
    const app = await import('../../../src/App.js');

    const frames = await Promise.all([
      capture('_shell-welcome', <WelcomeScreen onNavigate={noop} />),
      capture('_shell-integrations', <IntegrationsScreen onNavigate={noop} />),
      capture('_shell-settings', <app.SettingsPlaceholder onNavigate={noop as never} />),
    ]);

    // Every menu screen states movement and selection the same way. `esc` is
    // deliberately absent from the main menu — there is nowhere above it, and
    // offering a way back to nothing is worse than saying less.
    for (const frame of frames) {
      expect(frame).toContain('↑↓ move');
      expect(frame).toContain('⏎ select');
      // The nine hand-written variants the shared shell replaced.
      expect(frame).not.toMatch(/Press ESC or select Go Back|Use ↑↓ arrows|Press Enter to/);
    }

    const [welcome, integrations, settings] = frames;
    expect(welcome, 'the top-level menu has nowhere to go back to').not.toContain('esc back');
    for (const frame of [integrations, settings]) expect(frame).toContain('esc back');
  });
});
