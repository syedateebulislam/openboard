/**
 * Phase 11 — headless mode setup (`openboard agent setup mode`).
 *
 * The mode gates every later setup part: local restricts the LLM to Ollama,
 * and local/hybrid refuse GitHub/Vercel tokens (they are never used).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { SetupService } from '../../src/services/config/SetupService.js';
import type { SetupDeps } from '../../src/services/config/SetupService.js';

function makeDeps(over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    validateLLM: vi.fn(async () => ({ valid: true })),
    validateGitHubToken: vi.fn(async () => ({ login: 'octocat' })),
    ghLogin: vi.fn(async () => {}),
    validateVercelToken: vi.fn(async () => ({ success: true })),
    codexLogin: vi.fn(async () => ({ valid: true })),
    ...over,
  };
}

describe('SetupService modes', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ob-setup-mode-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'setup-mode-test-secret';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const newService = (deps?: Partial<SetupDeps>) => {
    const config = new ConfigService();
    return { config, setup: new SetupService(config, deps ?? makeDeps()) };
  };

  describe('configureMode', () => {
    it('saves a valid mode', () => {
      const { config, setup } = newService();
      const r = setup.configureMode('local');
      expect(r.configured).toBe(true);
      expect(config.get('app.mode')).toBe('local');
    });

    it('rejects invalid modes', () => {
      const { setup } = newService();
      const r = setup.configureMode('cloudy');
      expect(r.configured).toBe(false);
      expect(r.errorCode).toBe('E_VALIDATION');
      expect(r.error).toContain('local, hybrid, remote');
    });

    it('warns when the saved provider conflicts with the new mode', () => {
      const { config, setup } = newService();
      config.set('llm.provider', 'openai');
      const r = setup.configureMode('local');
      expect(r.configured).toBe(true);
      expect(r.detail).toContain('not allowed');
    });
  });

  describe('mode gating of setup parts', () => {
    it('local mode restricts the LLM to Ollama', async () => {
      const { setup } = newService();
      setup.configureMode('local');

      const cloud = await setup.configureLLM({ provider: 'openai', apiKey: 'sk-test' });
      expect(cloud.configured).toBe(false);
      expect(cloud.error).toContain('local');

      const ollama = await setup.configureLLM({ provider: 'ollama' });
      expect(ollama.configured).toBe(true);
    });

    it('hybrid mode allows cloud LLMs but refuses GitHub/Vercel tokens', async () => {
      const { setup } = newService();
      setup.configureMode('hybrid');

      expect((await setup.configureLLM({ provider: 'anthropic', apiKey: 'sk-ant' })).configured).toBe(true);

      const github = await setup.configureGitHub('ghp_token');
      expect(github.configured).toBe(false);
      expect(github.error).toContain('hybrid');

      const vercel = await setup.configureVercel('vc_token');
      expect(vercel.configured).toBe(false);
      expect(vercel.error).toContain('hybrid');
    });

    it('remote mode keeps the full pipeline configurable', async () => {
      const { setup } = newService();
      setup.configureMode('remote');

      expect((await setup.configureLLM({ provider: 'openai', apiKey: 'sk-test' })).configured).toBe(true);
      expect((await setup.configureGitHub('ghp_token')).configured).toBe(true);
      expect((await setup.configureVercel('vc_token')).configured).toBe(true);
    });

    it('unset mode behaves as remote (backward compatible)', async () => {
      const { setup } = newService();
      expect((await setup.configureGitHub('ghp_token')).configured).toBe(true);
    });
  });

  describe('status', () => {
    it('reports the mode with its description', () => {
      const { setup } = newService();
      setup.configureMode('hybrid');
      const status = setup.status();
      expect(status.mode).toBe('hybrid');
      expect(status.modeDescription).toContain('local preview');
    });

    it('defaults to remote when never configured', () => {
      const { setup } = newService();
      expect(setup.status().mode).toBe('remote');
    });
  });
});
