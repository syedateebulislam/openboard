import { defaultModelFor, normalizeEffort } from '../../config/llmCatalog.js';
import { getAppMode, providerAllowedInMode, providerModeMismatchMessage } from '../../config/appModes.js';
import type { AppMode } from '../../config/appModes.js';
import type { LLMConfig, LLMProviderName } from '../../types/llm.js';
import {
  BILLERS_DEFAULT_SINCE_DAYS,
  BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES,
  type BillerSettings,
} from '../../types/billers.js';
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
      throw new Error(providerModeMismatchMessage(llm.provider, mode));
    }
    return llm;
  }

  getBillerSettings(): BillerSettings {
    const interval = this.store.get('billers.syncIntervalMinutes');
    const sinceDays = this.store.get('billers.sinceDays');
    const enabled = this.store.get('billers.enabledKeys');
    return {
      scriptsDir: this.store.get('billers.scriptsDir') as string | undefined,
      email: this.store.get('billers.email') as string | undefined,
      appPassword: this.store.getSecret('billers.appPassword'),
      enabledKeys: Array.isArray(enabled)
        ? enabled.filter((key): key is string => typeof key === 'string')
        : [],
      syncIntervalMinutes: typeof interval === 'number' && interval >= 1
        ? Math.floor(interval)
        : BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES,
      sinceDays: typeof sinceDays === 'number' && sinceDays >= 1
        ? Math.floor(sinceDays)
        : BILLERS_DEFAULT_SINCE_DAYS,
      lastRunAt: this.store.get('billers.lastRunAt') as string | undefined,
    };
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

