/** Generic provider for services exposing OpenAI-compatible chat endpoints. */

import type OpenAI from 'openai';
import type {
  LLMCompletionOptions,
  LLMProvider,
  LLMStreamChunk,
  LLMValidationResult,
} from '../../types/llm.js';
import { startHeartbeat } from './heartbeat.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

/**
 * Request timeout for a model running on the user's own machine.
 *
 * The SDK defaults to 10 minutes, which is a sensible ceiling for a hosted API
 * — a request still open after that is a fault. It is the wrong ceiling for a
 * local server: a 27B model at ~16 tok/s spends roughly seven minutes reasoning
 * before it writes a line, and a full fetcher or dashboard runs past ten. The
 * abort then lands mid-output, so the answer is discarded as malformed and the
 * retry hits the same wall.
 *
 * Nothing is being waited on except the user's own GPU, so the ceiling only has
 * to be high enough that finishing is possible; /stop and ESC still cancel.
 */
export const LOCAL_LLM_TIMEOUT_MS = 45 * 60_000;

/**
 * The usable text of a reply, falling back to the reasoning channel.
 *
 * Reasoning models served through OpenAI-compatible endpoints put their thought
 * process in a non-standard `reasoning_content` field. Most fill `content` as
 * well, but some leave it empty and answer entirely in the reasoning channel —
 * in which case reading only `content` returns nothing and the caller reports a
 * model that said nothing at all, having in fact said a great deal.
 *
 * Preferring `content` keeps normal replies untouched; this only rescues the
 * case that would otherwise be silence.
 */
export function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const record = message as { content?: unknown; reasoning_content?: unknown };
  if (typeof record.content === 'string' && record.content.trim()) return record.content;
  if (typeof record.reasoning_content === 'string') return record.reasoning_content;
  return typeof record.content === 'string' ? record.content : '';
}

/** Whether a base URL points at this machine, and so at the user's own hardware. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    // URL keeps the brackets on an IPv6 host, so `[::1]` never equals `::1`.
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '0.0.0.0'
      || hostname.endsWith('.local');
  } catch {
    return false;
  }
}

/** Timeout for a base URL: generous when local, SDK default when hosted. */
export function timeoutForBaseUrl(baseUrl: string): number | undefined {
  return isLocalBaseUrl(baseUrl) ? LOCAL_LLM_TIMEOUT_MS : undefined;
}

export interface OpenAICompatibleProviderOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Request timeout in ms. Omitted leaves the SDK's own default of 10 minutes,
   * which is right for a hosted API and far too short for a local one — see
   * LOCAL_LLM_TIMEOUT_MS.
   */
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private clientPromise?: Promise<OpenAI>;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs?: number;
  private resolvedModel?: string;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    // Derived from the endpoint rather than the provider name, so a local
    // server reached through any registration gets the local ceiling.
    this.timeoutMs = options.timeoutMs ?? timeoutForBaseUrl(options.baseUrl);
  }

  private getClient(): Promise<OpenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('openai').then(
        ({ default: OpenAI }) => new OpenAI({
          apiKey: this.apiKey,
          baseURL: this.baseUrl,
          // Left undefined the SDK applies its own 10-minute default, which
          // silently severs a local model mid-answer: a 27B model at ~16 tok/s
          // needs longer than that to finish one dashboard or fetcher, and the
          // abort arrives as a generic failure after ten minutes of nothing.
          ...(this.timeoutMs !== undefined ? { timeout: this.timeoutMs } : {}),
        }),
      );
    }
    return this.clientPromise;
  }

  private async getModel(): Promise<string> {
    if (this.model !== '__auto__') return this.model;
    if (this.resolvedModel) return this.resolvedModel;
    const models = await this.listModels();
    const first = models[0];
    if (!first) {
      throw new Error(`${this.name} has no available language models. Download/load a model and start its local server.`);
    }
    this.resolvedModel = first;
    return first;
  }

  async validate(): Promise<LLMValidationResult> {
    try {
      const client = await this.getClient();
      const model = await this.getModel();
      await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return { valid: true };
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = sanitizeErrorMessage(raw);
      if (/network|fetch|ECONNREFUSED/i.test(message)) {
        throw new Error(`Network error connecting to ${this.name}: ${message}`);
      }
      return { valid: false, error: `${this.name} validation failed: ${message}` };
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    const response = await client.models.list();
    return response.data.map((model) => model.id);
  }

  async complete(options: LLMCompletionOptions): Promise<string> {
    const stopHeartbeat = startHeartbeat(options.onProgress, `${this.name} (${this.model})`);
    try {
      const client = await this.getClient();
      const model = await this.getModel();
      const response = await client.chat.completions.create({
        model,
        messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      }, { signal: options.signal });
      if (options.onUsage && response.usage) {
        options.onUsage({
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        });
      }
      return messageText(response.choices[0]?.message);
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeErrorMessage(raw));
    } finally {
      stopHeartbeat();
    }
  }

  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const client = await this.getClient();
    const model = await this.getModel();
    const stream = await client.chat.completions.create({
      model,
      messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
      temperature: options.temperature ?? 0.7,
    }, { signal: options.signal });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      const done = chunk.choices[0]?.finish_reason === 'stop';
      if (text || done) yield { text, done };
    }
  }
}
