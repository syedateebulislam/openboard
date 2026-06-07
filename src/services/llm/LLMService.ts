/**
 * LLMService — Provider factory facade for OpenBoard LLM integrations.
 *
 * Creates the appropriate LLMProvider implementation based on the user's
 * configured LLM settings (set during setup wizard and stored in ConfigService).
 *
 * Supported providers:
 *  - openai:    OpenAIProvider (requires apiKey)
 *  - openai-codex: OpenAICodexProvider (uses Codex CLI ChatGPT/API-key login)
 *  - anthropic: AnthropicProvider (requires apiKey)
 *  - ollama:    OllamaProvider (requires running local Ollama server)
 */

import type { LLMProvider, LLMConfig } from '../../types/llm.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { MoonshotProvider } from './MoonshotProvider.js';
import { OpenAICodexProvider } from './OpenAICodexProvider.js';

export class LLMService {
  /**
   * Create and return a concrete LLMProvider from the given config.
   *
   * @param config - LLM configuration from ConfigService
   * @returns Configured LLMProvider instance ready for use
   * @throws If the provider name is unknown
   */
  static createProvider(config: LLMConfig): LLMProvider {
    switch (config.provider) {
      case 'openai':
        if (!config.apiKey) {
          throw new Error('OpenAI provider requires an apiKey');
        }
        return new OpenAIProvider(config.apiKey, config.model ?? 'gpt-4o');

      case 'openai-codex':
        return new OpenAICodexProvider(config.model ?? 'gpt-5.5');

      case 'anthropic':
        if (!config.apiKey) {
          throw new Error('Anthropic provider requires an apiKey');
        }
        return new AnthropicProvider(config.apiKey, config.model ?? 'claude-sonnet-4-5');

      case 'ollama':
        return new OllamaProvider(
          config.ollamaHost ?? 'http://127.0.0.1:11434',
          config.model ?? 'qwen2.5-coder:7b',
        );

      case 'moonshot':
        if (!config.apiKey) {
          throw new Error('Moonshot AI provider requires an apiKey');
        }
        return new MoonshotProvider(config.apiKey, config.model ?? 'moonshot-v1-8k');

      default:
        throw new Error(
          `Unknown LLM provider: ${(config as { provider: string }).provider}`,
        );
    }
  }
}

export default LLMService;
