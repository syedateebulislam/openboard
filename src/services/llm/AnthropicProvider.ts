/**
 * AnthropicProvider — LLM provider implementation for Anthropic Claude models.
 *
 * Implements the LLMProvider interface using the official Anthropic Node.js SDK.
 * Handles Anthropic-specific message format differences:
 *  - System messages must be passed as top-level `system` param, NOT in messages[]
 *  - Streaming uses the messages.stream() API
 *  - No list models endpoint — returns hardcoded known model list
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMValidationResult,
  LLMMessage,
} from '../../types/llm.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /**
   * Validate the API key by making a minimal test request.
   * Returns { valid: true } on success.
   * Returns { valid: false, error } on auth failure.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { valid: true };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      return { valid: false, error: msg };
    }
  }

  /**
   * Return hardcoded list of available Claude models.
   * Anthropic does not provide a list models endpoint.
   */
  async listModels(): Promise<string[]> {
    return ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'];
  }

  /**
   * Separate system message from the messages array.
   * Anthropic API requires system message as a top-level parameter.
   *
   * @returns { system?: string, msgs: LLMMessage[] }
   */
  private separateSystem(messages: LLMMessage[]): {
    system?: string;
    msgs: LLMMessage[];
  } {
    const sysMsg = messages.find((m) => m.role === 'system');
    const msgs = messages.filter((m) => m.role !== 'system');
    return { system: sysMsg?.content, msgs };
  }

  /**
   * Generate a complete (non-streaming) response.
   * Returns the full text content block as a string.
   */
  async complete(options: LLMCompletionOptions): Promise<string> {
    const { system, msgs } = this.separateSystem(options.messages);
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: options.maxTokens ?? 4096,
        system,
        messages: msgs as Anthropic.MessageParam[],
      });
      if (options.onUsage && response.usage) {
        options.onUsage({
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        });
      }
      const block = response.content[0];
      return block.type === 'text' ? block.text : '';
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      if (msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        throw new Error(`Network error: ${msg}`);
      }
      throw new Error(msg);
    }
  }

  /**
   * Generate a streaming response using Anthropic's messages.stream() API.
   * Yields { text, done } chunks. Emits done: true on message_stop event.
   */
  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const { system, msgs } = this.separateSystem(options.messages);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      system,
      messages: msgs as Anthropic.MessageParam[],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { text: event.delta.text, done: false };
      } else if (event.type === 'message_stop') {
        yield { text: '', done: true };
      }
    }
  }
}
