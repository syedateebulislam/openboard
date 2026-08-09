/**
 * LLMService — Provider factory facade for OpenBoardCLI LLM integrations.
 *
 * Creates the appropriate LLMProvider implementation based on the user's
 * configured LLM settings (set during setup wizard and stored in ConfigService).
 *
 * Supported providers:
 *  - openai:    OpenAIProvider (requires apiKey)
 *  - openai-codex: OpenAICodexProvider (uses Codex CLI ChatGPT/API-key login)
 *  - anthropic: AnthropicProvider (requires apiKey)
 *  - moonshot:  MoonshotProvider (requires apiKey)
 *  - gemini:    GeminiProvider (requires Google AI Studio apiKey)
 *  - xai:       xAI's OpenAI-compatible API (requires apiKey)
 *  - mistral:   Mistral AI's OpenAI-compatible API (requires apiKey)
 *  - openrouter: OpenRouter's multi-provider API (requires apiKey)
 *  - lmstudio:  LM Studio local OpenAI-compatible server (no apiKey)
 *  - ollama:    OllamaProvider (requires running local Ollama server)
 */

import type { LLMProvider, LLMConfig } from '../../types/llm.js';
import { providerRegistry } from './ProviderRegistry.js';

export class LLMService {
  /**
   * Create and return a concrete LLMProvider from the given config.
   *
   * @param config - LLM configuration from ConfigService
   * @returns Configured LLMProvider instance ready for use
   * @throws If the provider name is unknown
   */
  static createProvider(config: LLMConfig): LLMProvider {
    return providerRegistry.create(config);
  }
}

export default LLMService;
