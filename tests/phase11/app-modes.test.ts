/**
 * Phase 11 — privacy-first app modes.
 *
 * The mode is the first choice in every setup surface so the user knows from
 * the beginning what the end result is:
 *   1. local  — local LLM (Ollama/LM Studio) + local preview only
 *   2. hybrid — cloud LLM + local preview only
 *   3. remote — cloud LLM + GitHub + live Vercel web app
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_MODES,
  allowedProvidersForMode,
  blockedDeployMessage,
  describeAppMode,
  getAppMode,
  isValidAppMode,
  modeAllowsCloudLLM,
  modeAllowsDeploy,
  providerAllowedInMode,
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
  it('lists modes privacy-first: local, then hybrid, then remote', () => {
    expect(APP_MODES.map((m) => m.id)).toEqual(['local', 'hybrid', 'remote']);
  });

  it('every mode states what the user gets at the end', () => {
    for (const mode of APP_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.summary.length).toBeGreaterThan(0);
      expect(mode.detail.length).toBeGreaterThan(0);
    }
    expect(describeAppMode('local')).toContain('local preview');
    expect(describeAppMode('hybrid')).toContain('local preview');
    expect(describeAppMode('remote')).toContain('Vercel');
  });

  it('validates mode ids', () => {
    expect(isValidAppMode('local')).toBe(true);
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

  it('hybrid mode allows cloud LLMs but not deploys', () => {
    expect(modeAllowsCloudLLM('hybrid')).toBe(true);
    expect(modeAllowsDeploy('hybrid')).toBe(false);
    expect(providerAllowedInMode('openai-codex', 'hybrid')).toBe(true);
    expect(providerAllowedInMode('anthropic', 'hybrid')).toBe(true);
    expect(providerAllowedInMode('ollama', 'hybrid')).toBe(false);
    expect(providerAllowedInMode('lmstudio', 'hybrid')).toBe(false);
  });

  it('remote mode allows the full pipeline', () => {
    expect(modeAllowsCloudLLM('remote')).toBe(true);
    expect(modeAllowsDeploy('remote')).toBe(true);
    expect(allowedProvidersForMode('remote')).toContain('ollama');
    expect(allowedProvidersForMode('remote')).toContain('lmstudio');
    expect(allowedProvidersForMode('remote')).toContain('openai');
  });

  it('blockedDeployMessage explains the mode and points at /preview + Settings', () => {
    const message = blockedDeployMessage('hybrid', 'deploy');
    expect(message).toContain('Hybrid');
    expect(message).toContain('/preview');
    expect(message).toContain('All remote');
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

  it('rejects invalid mode values on set', () => {
    const config = new ConfigService(configDir);
    expect(() => config.set('app.mode', 'cloud')).toThrow(/Invalid app mode/);
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
