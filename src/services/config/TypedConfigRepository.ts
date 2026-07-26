import { defaultModelFor, normalizeEffort } from '../../config/llmCatalog.js';
import { getAppMode, providerAllowedInMode } from '../../config/appModes.js';
import type { AppMode } from '../../config/appModes.js';
import type { LLMConfig, LLMProviderName } from '../../types/llm.js';
import {
  GMAIL_DEFAULT_MAX_RESULTS,
  GMAIL_DEFAULT_QUERY,
  GMAIL_DEFAULT_SYNC_INTERVAL_MINUTES,
  type GmailSettings,
} from '../../types/mail.js';
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

  getGmailSettings(): GmailSettings {
    const interval = this.store.get('gmail.syncIntervalMinutes');
    const maxResults = this.store.get('gmail.maxResults');
    return {
      clientId: this.store.get('gmail.clientId') as string | undefined,
      clientSecret: this.store.getSecret('gmail.clientSecret'),
      email: this.store.get('gmail.email') as string | undefined,
      query: (this.store.get('gmail.query') as string | undefined) || GMAIL_DEFAULT_QUERY,
      syncIntervalMinutes: typeof interval === 'number' && interval >= 1
        ? Math.floor(interval)
        : GMAIL_DEFAULT_SYNC_INTERVAL_MINUTES,
      maxResults: typeof maxResults === 'number' && maxResults >= 1
        ? Math.min(Math.floor(maxResults), 500)
        : GMAIL_DEFAULT_MAX_RESULTS,
      needsReauth: this.store.get('gmail.needsReauth') === true,
    };
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

