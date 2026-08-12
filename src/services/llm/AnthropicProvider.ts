/**
 * AnthropicProvider — LLM provider implementation for Anthropic Claude models.
 *
 * Implements the LLMProvider interface using the official Anthropic Node.js SDK.
 * Handles Anthropic-specific message format differences:
 *  - System messages must be passed as top-level `system` param, NOT in messages[]
 *  - Streaming uses the messages.stream() API
 *  - No list models endpoint — returns hardcoded known model list
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMEffort,
  LLMStreamChunk,
  LLMValidationResult,
  LLMMessage,
} from '../../types/llm.js';
import { anthropicThinkingBudget } from '../../config/llmCatalog.js';
import { startHeartbeat } from './heartbeat.js';
import { HOSTED_LLM_TIMEOUT_MS } from './OpenAICompatibleProvider.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private clientPromise?: Promise<Anthropic>;
  private apiKey: string;
  private model: string;
  private effort?: LLMEffort;

  constructor(apiKey: string, model: string, effort?: LLMEffort) {
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
  }

  /** Lazily import and instantiate the Anthropic SDK on first use to keep TUI startup fast. */
  private getClient(): Promise<Anthropic> {
    if (!this.clientPromise) {
      this.clientPromise = import('@anthropic-ai/sdk').then(
        ({ default: Anthropic }) =>
          new Anthropic({ apiKey: this.apiKey, timeout: HOSTED_LLM_TIMEOUT_MS }),
      );
    }
    return this.clientPromise;
  }

  /**
   * Validate the API key by making a minimal test request.
   * Returns { valid: true } on success.
   * Returns { valid: false, error } on auth failure.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      const client = await this.getClient();
      await client.messages.create({
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
    const stopHeartbeat = startHeartbeat(options.onProgress, `anthropic (${this.model})`);
    try {
      const client = await this.getClient();
      // high/max effort enables extended thinking; the budget must stay below
      // max_tokens, so max_tokens is raised to leave headroom for the answer.
      const thinkingBudget = anthropicThinkingBudget(this.effort, this.model);
      const maxTokens = thinkingBudget
        ? Math.max(options.maxTokens ?? 4096, thinkingBudget + 4096)
        : options.maxTokens ?? 4096;
      const response = await client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        ...(thinkingBudget
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
          : {}),
        system,
        messages: msgs as Anthropic.MessageParam[],
      }, { signal: options.signal });
      if (options.onUsage && response.usage) {
        options.onUsage({
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        });
      }
      // With thinking enabled the first block is a thinking block — return the
      // first text block regardless of position.
      const block = response.content.find((b) => b.type === 'text');
      return block && block.type === 'text' ? block.text : '';
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      if (msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        throw new Error(`Network error: ${msg}`);
      }
      throw new Error(msg);
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Generate a streaming response using Anthropic's messages.stream() API.
   * Yields { text, done } chunks. Emits done: true on message_stop event.
   */
  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const { system, msgs } = this.separateSystem(options.messages);
    const client = await this.getClient();
    const stream = client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      system,
      messages: msgs as Anthropic.MessageParam[],
    }, { signal: options.signal });

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
