/**
 * OllamaProvider — LLM provider implementation for local Ollama instances.
 *
 * Implements the LLMProvider interface using the official Ollama Node.js package.
 * Connects to a locally running Ollama server (default: http://127.0.0.1:11434).
 *
 * Handles:
 *  - Connection refused errors (Ollama not running)
 *  - Dynamic model listing from /api/tags
 *  - Standard chat completions with streaming support
 */

import { Ollama } from 'ollama';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMValidationResult,
} from '../../types/llm.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private client: Ollama;
  private model: string;

  constructor(host: string, model: string) {
    this.client = new Ollama({ host });
    this.model = model;
  }

  /**
   * Validate Ollama connection by listing installed models.
   * Returns { valid: true } if Ollama is running.
   * Returns { valid: false, error: "Connection refused..." } if not reachable.
   */
  async validate(): Promise<LLMValidationResult> {
    try {
      await this.client.list();
      return { valid: true };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(rawMsg);
      return {
        valid: false,
        error: `Connection refused — is Ollama running? ${msg}`,
      };
    }
  }

  /**
   * List all locally installed Ollama models.
   * Returns model names from Ollama's /api/tags endpoint.
   */
  async listModels(): Promise<string[]> {
    const response = await this.client.list();
    return response.models.map((m) => m.name);
  }

  /**
   * Generate a complete (non-streaming) chat response.
   * Returns the full assistant message content as a string.
   */
  async complete(options: LLMCompletionOptions): Promise<string> {
    const response = await this.client.chat({
      model: this.model,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
    return response.message.content;
  }

  /**
   * Generate a streaming chat response.
   * Yields { text, done } chunks. chunk.done indicates stream completion.
   */
  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const stream = await this.client.chat({
      model: this.model,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
    });

    for await (const chunk of stream) {
      yield {
        text: chunk.message.content,
        done: chunk.done,
      };
    }
  }
}
