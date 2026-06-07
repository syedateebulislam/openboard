import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { hasConfiguredLLM } from '../../src/screens/BoardCreationScreen.js';

describe('Board creation LLM readiness', () => {
  let tempDir: string;
  let cfg: ConfigService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openboard-create-ready-'));
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'board-create-readiness-secret';
    cfg = new ConfigService(tempDir);
  });

  afterEach(async () => {
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should block initial dashboard generation when no provider is configured', () => {
    expect(hasConfiguredLLM(cfg)).toBe(false);
  });

  it('should allow provider-only integrations that do not need an API key', () => {
    cfg.set('llm.provider', 'openai-codex');
    expect(hasConfiguredLLM(cfg)).toBe(true);

    cfg.set('llm.provider', 'ollama');
    expect(hasConfiguredLLM(cfg)).toBe(true);
  });

  it('should require a readable API key for remote API providers', () => {
    cfg.set('llm.provider', 'openai');
    expect(hasConfiguredLLM(cfg)).toBe(false);

    cfg.setEncrypted('llm.apiKey', 'sk-test');
    expect(hasConfiguredLLM(cfg)).toBe(true);
  });
});
