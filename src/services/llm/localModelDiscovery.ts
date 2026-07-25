/**
 * localModelDiscovery — live "what models are installed?" queries for local
 * LLM providers (Ollama, LM Studio). Wraps each provider's existing
 * listModels() behind a classified, non-throwing result so UI callers (Ink
 * components, chat commands) can render a single loading/result state
 * machine without try/catch.
 */

import { LLMService } from './LLMService.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export type LocalProviderName = 'ollama' | 'lmstudio';

export interface LocalModelChoice {
  label: string;
  value: string;
}

export type LocalModelFetchStatus = 'ok' | 'empty' | 'unreachable' | 'error';

export interface LocalModelFetchResult {
  status: LocalModelFetchStatus;
  models: LocalModelChoice[];
  /** Human-readable detail. Always set for non-'ok' statuses. */
  message?: string;
}

const LOCAL_PROVIDER_LABEL: Record<LocalProviderName, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Query a local provider's live endpoint for installed/loaded models.
 * Never throws — always resolves to a classified result.
 */
export async function fetchInstalledModels(
  provider: LocalProviderName,
  host: string,
  timeoutMs = 6000,
): Promise<LocalModelFetchResult> {
  const label = LOCAL_PROVIDER_LABEL[provider];
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    return { status: 'error', models: [], message: `Enter a ${label} host/URL first.` };
  }

  try {
    const provider_ = LLMService.createProvider(
      provider === 'ollama'
        ? { provider: 'ollama', ollamaHost: trimmedHost }
        : { provider: 'lmstudio', baseUrl: trimmedHost, apiKey: 'lm-studio' },
    );
    const names = await withTimeout(provider_.listModels(), timeoutMs);
    if (names.length === 0) {
      return {
        status: 'empty',
        models: [],
        message: provider === 'ollama'
          ? 'No models installed. Run "ollama pull <model>" (e.g. ollama pull qwen3.5:9b), then retry.'
          : 'No models loaded. Open LM Studio, download/load a model, start its local server, then retry.',
      };
    }
    return { status: 'ok', models: names.map((name) => ({ label: name, value: name })) };
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = sanitizeErrorMessage(raw);
    const unreachable = /ECONNREFUSED|fetch failed|network|ENOTFOUND|timed out/i.test(msg);
    return {
      status: unreachable ? 'unreachable' : 'error',
      models: [],
      message: unreachable
        ? `Can't reach ${label} at ${trimmedHost} — is it running? (${msg})`
        : `${label} returned an error: ${msg}`,
    };
  }
}
