/**
 * Phase 9 — headless setup (agent-driven configuration).
 *
 * SetupService configures LLM / GitHub / Vercel / dashboard-auth without the
 * TUI. Network/CLI side effects are injected so these tests run offline.
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

describe('SetupService (headless setup)', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ob-setup-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'setup-test-secret';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const newService = (deps?: Partial<SetupDeps>) => {
    const config = new ConfigService();
    return { config, setup: new SetupService(config, deps ?? makeDeps()) };
  };

  describe('LLM', () => {
    it('rejects an unknown/missing provider', async () => {
      const { setup } = newService();
      expect((await setup.configureLLM({})).errorCode).toBe('E_VALIDATION');
      expect((await setup.configureLLM({ provider: 'nope' })).errorCode).toBe('E_VALIDATION');
    });

    it('requires an API key for key-based providers', async () => {
      const { setup } = newService();
      const r = await setup.configureLLM({ provider: 'openai' });
      expect(r.configured).toBe(false);
      expect(r.errorCode).toBe('E_VALIDATION');
    });

    it('saves provider/model/api key when validation passes', async () => {
      const { config, setup } = newService(makeDeps());
      const r = await setup.configureLLM({ provider: 'openai', apiKey: 'sk-test' });
      expect(r.configured).toBe(true);
      expect(config.get('llm.provider')).toBe('openai');
      expect(config.get('llm.model')).toBe('gpt-4o'); // default applied
      expect(config.getDecrypted('llm.apiKey')).toBe('sk-test');
    });

    it('does not save when the provider fails validation', async () => {
      const deps = makeDeps({ validateLLM: vi.fn(async () => ({ valid: false, error: 'bad key' })) });
      const { config, setup } = newService(deps);
      const r = await setup.configureLLM({ provider: 'openai', apiKey: 'sk-bad' });
      expect(r.configured).toBe(false);
      expect(r.errorCode).toBe('E_LLM_FAILED');
      expect(config.get('llm.provider')).toBeUndefined();
    });

    it('configures codex without an API key when already signed in', async () => {
      const deps = makeDeps(); // validateLLM valid -> already logged in
      const { config, setup } = newService(deps);
      const r = await setup.configureLLM({ provider: 'openai-codex' });
      expect(r.configured).toBe(true);
      expect(config.get('llm.provider')).toBe('openai-codex');
      expect(config.has('llm.apiKey')).toBe(false);
      expect(deps.codexLogin).not.toHaveBeenCalled(); // no login needed
    });

    it('signs codex in when not logged in, then saves (no key stored)', async () => {
      const deps = makeDeps({
        validateLLM: vi.fn(async () => ({ valid: false, error: 'not logged in' })),
        codexLogin: vi.fn(async () => ({ valid: true })),
      });
      const { config, setup } = newService(deps);
      const r = await setup.configureLLM({ provider: 'openai-codex', codexAccessToken: 'tok_123' });
      expect(r.configured).toBe(true);
      expect(deps.codexLogin).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'tok_123' }));
      expect(config.get('llm.provider')).toBe('openai-codex');
      expect(config.has('llm.apiKey')).toBe(false);
    });

    it('fails when codex login fails', async () => {
      const deps = makeDeps({
        validateLLM: vi.fn(async () => ({ valid: false })),
        codexLogin: vi.fn(async () => ({ valid: false, error: 'device-auth timed out' })),
      });
      const { config, setup } = newService(deps);
      const r = await setup.configureLLM({ provider: 'openai-codex' });
      expect(r.configured).toBe(false);
      expect(r.errorCode).toBe('E_LLM_FAILED');
      expect(config.get('llm.provider')).toBeUndefined();
    });
  });

  describe('GitHub', () => {
    it('saves a valid token + username and primes gh login', async () => {
      const deps = makeDeps();
      const { config, setup } = newService(deps);
      const r = await setup.configureGitHub('ghp_valid');
      expect(r.configured).toBe(true);
      expect(config.getDecrypted('github.token')).toBe('ghp_valid');
      expect(config.get('github.username')).toBe('octocat');
      expect(deps.ghLogin).toHaveBeenCalledWith('ghp_valid');
    });

    it('rejects a missing or invalid token without saving', async () => {
      const deps = makeDeps({ validateGitHubToken: vi.fn(async () => ({ error: 'Invalid GitHub token (HTTP 401)' })) });
      const { config, setup } = newService(deps);
      expect((await setup.configureGitHub('')).errorCode).toBe('E_VALIDATION');
      const r = await setup.configureGitHub('ghp_bad');
      expect(r.configured).toBe(false);
      expect(config.has('github.token')).toBe(false);
    });
  });

  describe('Vercel', () => {
    it('saves a valid token', async () => {
      const { config, setup } = newService(makeDeps());
      const r = await setup.configureVercel('vc_valid');
      expect(r.configured).toBe(true);
      expect(config.getDecrypted('vercel.token')).toBe('vc_valid');
    });

    it('returns E_DEPLOY_AUTH for an invalid token without saving', async () => {
      const deps = makeDeps({ validateVercelToken: vi.fn(async () => ({ success: false, error: 'bad' })) });
      const { config, setup } = newService(deps);
      const r = await setup.configureVercel('vc_bad');
      expect(r.errorCode).toBe('E_DEPLOY_AUTH');
      expect(config.has('vercel.token')).toBe(false);
    });
  });

  describe('Dashboard auth', () => {
    it('saves username + bcrypt hash + jwt secret', async () => {
      const { config, setup } = newService(makeDeps());
      const r = await setup.configureDashboardAuth('admin', 'supersecret');
      expect(r.configured).toBe(true);
      expect(config.get('credentials.username')).toBe('admin');
      expect(config.getDecrypted('credentials.passwordHash')).toMatch(/^\$2[aby]\$/);
      expect(config.getDecrypted('credentials.jwtSecret').length).toBeGreaterThan(0);
    });

    it('rejects a short password and a missing username', async () => {
      const { config, setup } = newService(makeDeps());
      expect((await setup.configureDashboardAuth('admin', 'short')).errorCode).toBe('E_VALIDATION');
      expect((await setup.configureDashboardAuth('', 'supersecret')).errorCode).toBe('E_VALIDATION');
      expect(config.get('credentials.username')).toBeUndefined();
    });
  });

  it('status reflects what has been configured', async () => {
    const { setup } = newService(makeDeps());
    expect(setup.status()).toEqual({ llm: null, github: null, vercel: false, dashboardAuth: false });
    await setup.configureLLM({ provider: 'openai', apiKey: 'sk-test' });
    await setup.configureDashboardAuth('admin', 'supersecret');
    const status = setup.status();
    expect(status.llm).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(status.dashboardAuth).toBe(true);
  });
});
