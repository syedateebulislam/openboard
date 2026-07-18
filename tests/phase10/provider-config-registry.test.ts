import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLM_PROVIDER_NAMES } from '../../src/config/llmCatalog.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import { ProviderRegistry, providerRegistry } from '../../src/services/llm/ProviderRegistry.js';

describe('provider registry and typed configuration', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-typed-config-'));
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'typed-config-test-secret';
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('registers every provider exposed by the shared catalog exactly once', () => {
    expect(providerRegistry.list().map((item) => item.name).sort()).toEqual([...LLM_PROVIDER_NAMES].sort());
  });

  it('supports extension through an injected provider registration', () => {
    const registry = new ProviderRegistry([]);
    registry.register({
      name: 'ollama', requiresApiKey: false,
      create: () => ({
        name: 'test-ollama', validate: async () => ({ valid: true }), listModels: async () => [],
        complete: async () => '', stream: async function* () { yield { text: '', done: true }; },
      }),
    });
    expect(registry.create({ provider: 'ollama' }).name).toBe('test-ollama');
  });

  it('round-trips an encrypted, typed LLM configuration', () => {
    const store = new ConfigService(configDir);
    store.set('app.mode', 'remote');
    const repository = new TypedConfigRepository(store);
    repository.saveLLMConfig({ provider: 'openai', model: 'gpt-test', apiKey: 'secret', effort: 'high' });

    expect(store.get('llm.apiKey')).not.toBe('secret');
    expect(repository.requireLLMConfig()).toMatchObject({
      provider: 'openai', model: 'gpt-test', apiKey: 'secret', effort: 'high',
    });
  });

  it('enforces the privacy mode at the repository boundary', () => {
    const store = new ConfigService(configDir);
    store.set('app.mode', 'local');
    store.set('llm.provider', 'openai');
    const repository = new TypedConfigRepository(store);
    expect(() => repository.requireLLMConfig()).toThrow(/not allowed in local mode/i);
  });
});

