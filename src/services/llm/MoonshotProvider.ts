/**
 * MoonshotProvider — LLM provider implementation for Moonshot AI (Kimi models).
 *
 * Implements the LLMProvider interface using OpenAI-compatible API.
 * Moonshot AI provides Kimi models including Kimi 2.5.
 * 
 * API: https://api.moonshot.cn/v1
 * Models: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, etc.
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMValidationResult,
} from '../../types/llm.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class MoonshotProvider implements LLMProvider {
  readonly name = 'moonshot';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    // Moonshot uses OpenAI-compatible API
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.moonshot.cn/v1',
    });
    this.model = model;
  }

  /**
   * Validate the API key by listing models.
   * Returns { valid: true } on success.
   * Returns { valid: false, error } on auth failure.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      // Test with a minimal completion request instead of list models
      // Some providers don't support model listing
      const testResponse = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return { valid: true };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      // Network errors should bubble up, not be swallowed as invalid
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        throw new Error(`Network error connecting to Moonshot AI: ${msg}`);
      }
      // Return the full error for debugging
      return { valid: false, error: `Moonshot validation failed: ${msg}` };
    }
  }

  /**
   * List available Moonshot models.
   */
  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    return response.data.map((m) => m.id);
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
      if (options.onUsage && response.usage) {
        options.onUsage({
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        });
      }
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
