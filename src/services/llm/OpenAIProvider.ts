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

import type OpenAI from 'openai';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMEffort,
  LLMStreamChunk,
  LLMValidationResult,
} from '../../types/llm.js';
import { openaiReasoningEffort } from '../../config/llmCatalog.js';
import { startHeartbeat } from './heartbeat.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private clientPromise?: Promise<OpenAI>;
  private apiKey: string;
  private model: string;
  private effort?: LLMEffort;

  constructor(apiKey: string, model: string, effort?: LLMEffort) {
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
  }

  /** Lazily import and instantiate the OpenAI SDK on first use to keep TUI startup fast. */
  private getClient(): Promise<OpenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('openai').then(
        ({ default: OpenAI }) => new OpenAI({ apiKey: this.apiKey }),
      );
    }
    return this.clientPromise;
  }

  /**
   * Validate the API key by listing models.
   * Returns { valid: true } on success.
   * Returns { valid: false, error } on auth failure (401).
   * Throws on network errors.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      const client = await this.getClient();
      await client.models.list();
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
    const client = await this.getClient();
    const response = await client.models.list();
    return response.data.map((m) => m.id).filter((id) => id.startsWith('gpt'));
  }

  /**
   * Generate a complete (non-streaming) chat completion.
   * Returns the full assistant message as a string.
   */
  async complete(options: LLMCompletionOptions): Promise<string> {
    const stopHeartbeat = startHeartbeat(options.onProgress, `openai (${this.model})`);
    try {
      const client = await this.getClient();
      // Reasoning-capable models take reasoning_effort and reject both
      // temperature and max_tokens (they require max_completion_tokens).
      const reasoningEffort = openaiReasoningEffort(this.model, this.effort);
      const response = await client.chat.completions.create({
        model: this.model,
        messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(reasoningEffort
          ? {
              reasoning_effort: reasoningEffort,
              max_completion_tokens: options.maxTokens ?? 4096,
            }
          : {
              temperature: options.temperature ?? 0.7,
              max_tokens: options.maxTokens ?? 4096,
            }),
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
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Generate a streaming chat completion.
   * Yields { text, done } chunks. Final chunk has done: true.
   */
  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const client = await this.getClient();
    const stream = await client.chat.completions.create({
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
