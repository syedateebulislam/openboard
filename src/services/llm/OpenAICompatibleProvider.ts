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

export interface OpenAICompatibleProviderOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private clientPromise?: Promise<OpenAI>;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private resolvedModel?: string;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
  }

  private getClient(): Promise<OpenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('openai').then(
        ({ default: OpenAI }) => new OpenAI({ apiKey: this.apiKey, baseURL: this.baseUrl }),
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
      });
      if (options.onUsage && response.usage) {
        options.onUsage({
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        });
      }
      return response.choices[0]?.message?.content ?? '';
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
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      const done = chunk.choices[0]?.finish_reason === 'stop';
      if (text || done) yield { text, done };
    }
  }
}
