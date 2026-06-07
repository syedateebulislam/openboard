/**
 * OpenAIProvider — LLM provider implementation for OpenAI GPT models.
 *
 * Implements the LLMProvider interface using the official OpenAI Node.js SDK.
 * Supports validate(), listModels(), complete(), and stream().
 *
 * Handles:
 *  - Network errors (ECONNREFUSED, fetch failures)
 *  - Auth errors (401 Invalid API key)
 *  - Rate limiting (429)
 *  - Context window overflow
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMValidationResult,
} from '../../types/llm.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  /**
   * Validate the API key by listing models.
   * Returns { valid: true } on success.
   * Returns { valid: false, error } on auth failure (401).
   * Throws on network errors.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      await this.client.models.list();
      return { valid: true };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      // Network errors should bubble up, not be swallowed as invalid
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        throw new Error(`Network error connecting to OpenAI: ${msg}`);
      }
      return { valid: false, error: msg };
    }
  }

  /**
   * List available OpenAI models, filtered to GPT models only.
   */
  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    return response.data.map((m) => m.id).filter((id) => id.startsWith('gpt'));
  }

  /**
   * Generate a complete (non-streaming) chat completion.
   * Returns the full assistant message as a string.
   */
  async complete(options: LLMCompletionOptions): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      });
      return response.choices[0]?.message?.content ?? '';
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('network')) {
        throw new Error(`Network error: ${msg}`);
      }
      if (msg.includes('429')) {
        throw new Error(`Rate limit exceeded: ${msg}`);
      }
      if (msg.includes('context') || msg.includes('token')) {
        throw new Error(`Context window exceeded: ${msg}`);
      }
      throw new Error(msg);
    }
  }

  /**
   * Generate a streaming chat completion.
   * Yields { text, done } chunks. Final chunk has done: true.
   */
  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
      temperature: options.temperature ?? 0.7,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      const done = chunk.choices[0]?.finish_reason === 'stop';
      if (text || done) {
        yield { text, done };
      }
    }
  }
}
