import type { LLMConfig, LLMProvider, LLMProviderName } from '../../types/llm.js';
import { defaultModelFor } from '../../config/llmCatalog.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { MoonshotProvider } from './MoonshotProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { OpenAICodexProvider } from './OpenAICodexProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';

export interface ProviderRegistration {
  readonly name: LLMProviderName;
  readonly requiresApiKey: boolean;
  create(config: LLMConfig): LLMProvider;
}

function requireApiKey(config: LLMConfig, label: string): string {
  if (!config.apiKey) throw new Error(`${label} provider requires an apiKey`);
  return config.apiKey;
}

const compatible = (
  name: 'xai' | 'mistral' | 'openrouter',
  baseUrl: string,
): ProviderRegistration => ({
  name,
  requiresApiKey: true,
  create: (config) => new OpenAICompatibleProvider({
    name,
    apiKey: requireApiKey(config, name),
    baseUrl,
    model: config.model ?? defaultModelFor(name),
  }),
});

const registrations: ProviderRegistration[] = [
  {
    name: 'openai', requiresApiKey: true,
    create: (config) => new OpenAIProvider(
      requireApiKey(config, 'OpenAI'), config.model ?? defaultModelFor('openai'), config.effort,
    ),
  },
  {
    name: 'openai-codex', requiresApiKey: false,
    create: (config) => new OpenAICodexProvider(config.model ?? defaultModelFor('openai-codex'), config.effort),
  },
  {
    name: 'anthropic', requiresApiKey: true,
    create: (config) => new AnthropicProvider(
      requireApiKey(config, 'Anthropic'), config.model ?? defaultModelFor('anthropic'), config.effort,
    ),
  },
  {
    name: 'gemini', requiresApiKey: true,
    create: (config) => new GeminiProvider(
      requireApiKey(config, 'Google Gemini'), config.model ?? defaultModelFor('gemini'),
    ),
  },
  {
    name: 'moonshot', requiresApiKey: true,
    create: (config) => new MoonshotProvider(
      requireApiKey(config, 'Moonshot AI'), config.model ?? defaultModelFor('moonshot'),
    ),
  },
  compatible('xai', 'https://api.x.ai/v1'),
  compatible('mistral', 'https://api.mistral.ai/v1'),
  compatible('openrouter', 'https://openrouter.ai/api/v1'),
  {
    name: 'lmstudio', requiresApiKey: false,
    create: (config) => new OpenAICompatibleProvider({
      name: 'lmstudio', apiKey: config.apiKey ?? 'lm-studio',
      baseUrl: config.baseUrl ?? 'http://127.0.0.1:1234/v1',
      model: config.model ?? defaultModelFor('lmstudio'),
    }),
  },
  {
    name: 'ollama', requiresApiKey: false,
    create: (config) => new OllamaProvider(
      config.ollamaHost ?? 'http://127.0.0.1:11434', config.model ?? defaultModelFor('ollama'),
    ),
  },
];

/** Single source of truth for provider construction and authentication policy. */
export class ProviderRegistry {
  private readonly providers = new Map<LLMProviderName, ProviderRegistration>();

  constructor(items: ProviderRegistration[] = registrations) {
    for (const item of items) this.register(item);
  }

  register(item: ProviderRegistration): void {
    this.providers.set(item.name, item);
  }

  list(): ProviderRegistration[] {
    return [...this.providers.values()];
  }

  create(config: LLMConfig): LLMProvider {
    if (!config.provider) throw new Error('No LLM provider configured');
    const registration = this.providers.get(config.provider);
    if (!registration) throw new Error(`Unknown LLM provider: ${String(config.provider)}`);
    return registration.create(config);
  }
}

export const providerRegistry = new ProviderRegistry();

