/**
 * PHASE 13: Live model discovery for local LLM providers (Ollama, LM Studio).
 *
 * Verifies fetchInstalledModels() classifies the underlying provider's
 * listModels() result/failure into the ok/empty/unreachable/error states the
 * UI (LocalModelPicker, ChatScreen /model) relies on, without ever throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMService } from '../../src/services/llm/LLMService.js';
import { fetchInstalledModels } from '../../src/services/llm/localModelDiscovery.js';

function fakeProvider(listModels: () => Promise<string[]>) {
  return {
    name: 'fake',
    validate: async () => ({ valid: true }),
    listModels,
    complete: async () => '',
    stream: async function* () {
      yield { text: '', done: true };
    },
  };
}

describe('fetchInstalledModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok with the live model list on success', async () => {
    vi.spyOn(LLMService, 'createProvider').mockReturnValue(
      fakeProvider(async () => ['qwen3.5:9b', 'llama4:scout']),
    );

    const result = await fetchInstalledModels('ollama', 'http://127.0.0.1:11434');

    expect(result.status).toBe('ok');
    expect(result.models).toEqual([
      { label: 'qwen3.5:9b', value: 'qwen3.5:9b' },
      { label: 'llama4:scout', value: 'llama4:scout' },
    ]);
  });

  it('returns empty with an actionable message when no models are installed', async () => {
    vi.spyOn(LLMService, 'createProvider').mockReturnValue(fakeProvider(async () => []));

    const result = await fetchInstalledModels('ollama', 'http://127.0.0.1:11434');

    expect(result.status).toBe('empty');
    expect(result.models).toEqual([]);
    expect(result.message).toMatch(/ollama pull/i);
  });

  it('classifies a connection-refused error as unreachable', async () => {
    vi.spyOn(LLMService, 'createProvider').mockReturnValue(
      fakeProvider(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      }),
    );

    const result = await fetchInstalledModels('ollama', 'http://127.0.0.1:11434');

    expect(result.status).toBe('unreachable');
    expect(result.message).toMatch(/is it running/i);
  });

  it('classifies an unrelated thrown error as error, not unreachable', async () => {
    vi.spyOn(LLMService, 'createProvider').mockReturnValue(
      fakeProvider(async () => {
        throw new Error('unexpected 500 response');
      }),
    );

    const result = await fetchInstalledModels('lmstudio', 'http://127.0.0.1:1234/v1');

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/LM Studio returned an error/i);
  });

  it('times out instead of hanging when the endpoint never resolves', async () => {
    vi.spyOn(LLMService, 'createProvider').mockReturnValue(
      fakeProvider(() => new Promise(() => {})),
    );

    const result = await fetchInstalledModels('ollama', 'http://127.0.0.1:11434', 20);

    expect(result.status).toBe('unreachable');
  });

  it('short-circuits with an error when no host is provided', async () => {
    const spy = vi.spyOn(LLMService, 'createProvider');

    const result = await fetchInstalledModels('ollama', '   ');

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Enter a Ollama host/i);
    expect(spy).not.toHaveBeenCalled();
  });
});
