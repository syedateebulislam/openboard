import { defaultModelFor, normalizeEffort } from '../../config/llmCatalog.js';
import { getAppMode, providerAllowedInMode } from '../../config/appModes.js';
import type { AppMode } from '../../config/appModes.js';
import type { LLMConfig, LLMProviderName } from '../../types/llm.js';
import { ConfigService } from './ConfigService.js';

export interface OpenBoardRuntimeConfig {
  mode: AppMode;
  llm?: LLMConfig & { provider: LLMProviderName; model: string };
}

/** Typed boundary over the legacy dot-key configuration store. */
export class TypedConfigRepository {
  constructor(readonly store = new ConfigService()) {}

  getRuntimeConfig(): OpenBoardRuntimeConfig {
    return { mode: getAppMode(this.store), llm: this.getLLMConfig() };
  }

  getLLMConfig(): OpenBoardRuntimeConfig['llm'] {
    const provider = this.store.get('llm.provider') as LLMProviderName | undefined;
    if (!provider) return undefined;
    let apiKey: string | undefined;
    try {
      apiKey = this.store.getDecrypted('llm.apiKey');
    } catch {
      const raw = this.store.get('llm.apiKey');
      apiKey = typeof raw === 'string' && !raw.startsWith('enc:') ? raw : undefined;
    }
    return {
      provider,
      model: (this.store.get('llm.model') as string | undefined) || defaultModelFor(provider),
      apiKey,
      baseUrl: this.store.get('llm.baseUrl') as string | undefined,
      ollamaHost: this.store.get('llm.ollamaHost') as string | undefined,
      effort: normalizeEffort(this.store.get('llm.effort')),
    };
  }

  requireLLMConfig(): NonNullable<OpenBoardRuntimeConfig['llm']> {
    const llm = this.getLLMConfig();
    if (!llm) throw new Error('No LLM provider configured. Configure LLM settings first.');
    const mode = getAppMode(this.store);
    if (!providerAllowedInMode(llm.provider, mode)) {
      const guidance = mode === 'local'
        ? 'Local only mode generates with Ollama or LM Studio on your machine.'
        : 'Hybrid mode supports cloud LLM providers only; choose Local only or All remote to use a local provider.';
      throw new Error(
        `LLM provider "${llm.provider}" is not allowed in ${mode} mode — ${guidance} ` +
        'Switch the provider (Settings > Update LLM provider) or change the mode (Settings > App mode).',
      );
    }
    return llm;
  }

  saveLLMConfig(config: LLMConfig & { provider: LLMProviderName }): void {
    this.store.set('llm.provider', config.provider);
    this.store.set('llm.model', config.model ?? defaultModelFor(config.provider));
    this.store.set('llm.effort', normalizeEffort(config.effort));
    if (config.apiKey) this.store.setEncrypted('llm.apiKey', config.apiKey);
    else this.store.delete('llm.apiKey');
    if (config.baseUrl) this.store.set('llm.baseUrl', config.baseUrl);
    else this.store.delete('llm.baseUrl');
    if (config.ollamaHost) this.store.set('llm.ollamaHost', config.ollamaHost);
    else this.store.delete('llm.ollamaHost');
  }
}

