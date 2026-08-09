/**
 * Phase 11 — privacy-first app modes.
 *
 * The mode is the first choice in every setup surface so the user knows from
 * the beginning what the end result is. It is two independent axes — where the
 * LLM runs, and whether the pipeline deploys — so there are four:
 *   1. local        — local LLM (Ollama/LM Studio) + local preview only
 *   2. hybrid-local — local LLM (Ollama/LM Studio) + GitHub + live Vercel app
 *   3. hybrid       — cloud LLM + local preview only
 *   4. remote       — cloud LLM + GitHub + live Vercel web app
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_MODES,
  allowedProvidersForMode,
  appModeInfo,
  blockedDeployMessage,
  describeAppMode,
  getAppMode,
  isValidAppMode,
  modeAllowsCloudLLM,
  modeAllowsDeploy,
  providerAllowedInMode,
  providerModeMismatchMessage,
} from '../../src/config/appModes.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { chatCommandsForMode, commandsTextForMode, helpTextForMode, CHAT_COMMANDS } from '../../src/utils/commandParser.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'openboard-modes-'));
  process.env.OPENBOARD_CONFIG_DIR = configDir;
  process.env.OPENBOARD_ENCRYPTION_SECRET = 'app-modes-test';
});

afterEach(() => {
  delete process.env.OPENBOARD_CONFIG_DIR;
  delete process.env.OPENBOARD_ENCRYPTION_SECRET;
  try { rmSync(configDir, { recursive: true, force: true }); } catch { /* locks */ }
});

describe('app mode model', () => {
  it('lists modes privacy-first, local-LLM modes before cloud-LLM ones', () => {
    expect(APP_MODES.map((m) => m.id)).toEqual(['local', 'hybrid-local', 'hybrid', 'remote']);
  });

  it('covers the full LLM x deploy matrix exactly once', () => {
    const cells = APP_MODES.map((m) => `${m.llm}/${m.deploy}`);
    expect(new Set(cells).size).toBe(4);
    expect(cells).toHaveLength(4);
  });

  it('every mode states what the user gets at the end', () => {
    for (const mode of APP_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.summary.length).toBeGreaterThan(0);
      expect(mode.detail.length).toBeGreaterThan(0);
    }
    expect(describeAppMode('local')).toContain('local preview');
    expect(describeAppMode('hybrid-local')).toContain('Vercel');
    expect(describeAppMode('hybrid')).toContain('local preview');
    expect(describeAppMode('remote')).toContain('Vercel');
  });

  it('labels tell the two hybrids apart', () => {
    expect(describeAppMode('hybrid-local')).not.toEqual(describeAppMode('hybrid'));
    expect(appModeInfo('hybrid-local').label).toContain('local LLM');
    expect(appModeInfo('hybrid').label).toContain('cloud LLM');
  });

  it('validates mode ids', () => {
    expect(isValidAppMode('local')).toBe(true);
    expect(isValidAppMode('hybrid-local')).toBe(true);
    expect(isValidAppMode('hybrid')).toBe(true);
    expect(isValidAppMode('remote')).toBe(true);
    expect(isValidAppMode('cloud')).toBe(false);
    expect(isValidAppMode(undefined)).toBe(false);
  });

  it('local mode allows neither cloud LLMs nor deploys', () => {
    expect(modeAllowsCloudLLM('local')).toBe(false);
    expect(modeAllowsDeploy('local')).toBe(false);
    expect(allowedProvidersForMode('local')).toEqual(['ollama', 'lmstudio']);
    expect(providerAllowedInMode('openai', 'local')).toBe(false);
    expect(providerAllowedInMode('ollama', 'local')).toBe(true);
    expect(providerAllowedInMode('lmstudio', 'local')).toBe(true);
  });

  it('hybrid-local mode deploys but keeps generation on the machine', () => {
    expect(modeAllowsCloudLLM('hybrid-local')).toBe(false);
    expect(modeAllowsDeploy('hybrid-local')).toBe(true);
    expect(allowedProvidersForMode('hybrid-local')).toEqual(['ollama', 'lmstudio']);
    expect(providerAllowedInMode('ollama', 'hybrid-local')).toBe(true);
    expect(providerAllowedInMode('lmstudio', 'hybrid-local')).toBe(true);
    expect(providerAllowedInMode('openai', 'hybrid-local')).toBe(false);
    expect(providerAllowedInMode('anthropic', 'hybrid-local')).toBe(false);
  });

  it('hybrid mode allows cloud LLMs but not deploys', () => {
    expect(modeAllowsCloudLLM('hybrid')).toBe(true);
    expect(modeAllowsDeploy('hybrid')).toBe(false);
    expect(providerAllowedInMode('openai-codex', 'hybrid')).toBe(true);
    expect(providerAllowedInMode('anthropic', 'hybrid')).toBe(true);
    expect(providerAllowedInMode('ollama', 'hybrid')).toBe(false);
    expect(providerAllowedInMode('lmstudio', 'hybrid')).toBe(false);
  });

  it('remote mode deploys and is cloud-LLM only', () => {
    expect(modeAllowsCloudLLM('remote')).toBe(true);
    expect(modeAllowsDeploy('remote')).toBe(true);
    expect(allowedProvidersForMode('remote')).toContain('openai');
    // Narrowed: "local LLM + deploy" is hybrid-local's cell, not remote's, so
    // each mode stays one honest promise instead of two overlapping ones.
    expect(allowedProvidersForMode('remote')).not.toContain('ollama');
    expect(allowedProvidersForMode('remote')).not.toContain('lmstudio');
  });

  it('blockedDeployMessage explains the mode and points at /preview + Settings', () => {
    const message = blockedDeployMessage('hybrid', 'deploy');
    expect(message).toContain('Hybrid');
    expect(message).toContain('/preview');
    expect(message).toContain('All remote');
  });

  it('blockedDeployMessage keeps the user on their own LLM axis', () => {
    // A Local only user wanting a live app should be sent to Hybrid (local LLM),
    // not told to start sending prompts to a cloud provider.
    const message = blockedDeployMessage('local', 'push');
    expect(message).toContain('Hybrid (local LLM)');
    expect(message).not.toContain('All remote');
  });

  it('providerModeMismatchMessage names the mode that fits the provider', () => {
    const message = providerModeMismatchMessage('ollama', 'remote');
    expect(message).toContain('ollama');
    expect(message).toContain('remote');
    expect(message).toContain('Hybrid (local LLM)');

    const reverse = providerModeMismatchMessage('openai', 'hybrid-local');
    expect(reverse).toContain('All remote');
  });
});

describe('mode persistence in ConfigService', () => {
  it('defaults to remote (existing installs keep the full pipeline)', () => {
    expect(getAppMode(new ConfigService(configDir))).toBe('remote');
  });

  it('round-trips a stored mode', () => {
    const config = new ConfigService(configDir);
    config.set('app.mode', 'local');
    expect(getAppMode(config)).toBe('local');
    expect(getAppMode(new ConfigService(configDir))).toBe('local');
  });

  it('accepts every advertised mode id (config schema stays in sync)', () => {
    // The Zod enum in ConfigService is a separate literal from APP_MODE_IDS —
    // this is what catches the two drifting apart.
    for (const mode of APP_MODES) {
      const config = new ConfigService(configDir);
      config.set('app.mode', mode.id);
      expect(getAppMode(new ConfigService(configDir))).toBe(mode.id);
    }
  });

  it('rejects invalid mode values on set', () => {
    const config = new ConfigService(configDir);
    expect(() => config.set('app.mode', 'cloud')).toThrow(/Invalid app mode/);
  });

  it('reads an unset mode with a local provider as hybrid-local', () => {
    // Upgrade path: these installs predate modes and were never asked to pick
    // one. Defaulting them to remote would refuse the Ollama/LM Studio setup
    // they already had working, since remote is cloud-only.
    const config = new ConfigService(configDir);
    config.set('llm.provider', 'ollama');
    expect(getAppMode(config)).toBe('hybrid-local');
    expect(providerAllowedInMode('ollama', getAppMode(config))).toBe(true);

    config.set('llm.provider', 'lmstudio');
    expect(getAppMode(new ConfigService(configDir))).toBe('hybrid-local');
  });

  it('still defaults to remote for an unset mode on a cloud provider', () => {
    const config = new ConfigService(configDir);
    config.set('llm.provider', 'openai');
    expect(getAppMode(config)).toBe('remote');
  });

  it('never lets the inferred mode override an explicitly stored one', () => {
    const config = new ConfigService(configDir);
    config.set('llm.provider', 'ollama');
    config.set('app.mode', 'local');
    expect(getAppMode(config)).toBe('local');
  });

  it('falls back to remote for corrupted stored values', () => {
    const config = new ConfigService(configDir);
    config.set('app', { mode: undefined });
    expect(getAppMode(config)).toBe('remote');
  });
});

describe('chat commands under mode contracts', () => {
  it('hides /deploy and /push when deploy is not allowed', () => {
    const commands = chatCommandsForMode(false).map((c) => c.command);
    expect(commands).not.toContain('/deploy');
    expect(commands).not.toContain('/push');
    expect(commands).toContain('/preview');
    expect(commands).toContain('/build');
  });

  it('shows the full palette when deploy is allowed', () => {
    expect(chatCommandsForMode(true)).toEqual(CHAT_COMMANDS);
  });

  it('help and palette text omit remote-only commands in local/hybrid', () => {
    expect(helpTextForMode(false)).not.toMatch(/\/deploy\s/);
    expect(helpTextForMode(false)).not.toMatch(/\/push\s/);
    expect(helpTextForMode(false)).toContain('/preview');
    expect(commandsTextForMode(false)).not.toContain('/deploy');
    expect(helpTextForMode(true)).toContain('/deploy');
  });
});
