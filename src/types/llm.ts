/**
 * LLM (Large Language Model) type definitions for OpenBoard.
 */

export type LLMProviderName = 'openai' | 'openai-codex' | 'anthropic' | 'ollama' | 'moonshot';

/** @deprecated Use LLMProviderName instead */
export type LLMProvider_Type = LLMProviderName;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionOptions {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Optional progress sink. Long-running providers (e.g. the Codex CLI) emit
   * heartbeat/log lines here so non-interactive callers stay alive instead of
   * looking wedged. Providers without streaming may ignore it.
   */
  onProgress?: (line: string) => void;
  /**
   * Optional token-usage sink. Providers that report usage (OpenAI, Anthropic,
   * Moonshot, Ollama) call this once per completion; providers that cannot
   * (Codex CLI) skip it and callers fall back to a chars/4 estimate.
   */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

export interface LLMValidationResult {
  valid: boolean;
  error?: string;
}

export interface LLMStreamChunk {
  text: string;
  done: boolean;
}

export interface LLMConfig {
  provider?: LLMProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  ollamaHost?: string;
}

/**
 * Interface that all LLM providers must implement.
 */
export interface LLMProvider {
  readonly name: string;
  validate(): Promise<LLMValidationResult>;
  listModels(): Promise<string[]>;
  complete(options: LLMCompletionOptions): Promise<string>;
  stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk>;
}

export interface LLMRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'error';
}

export interface LLMProvider_Interface {
  provider: LLMProviderName;
  chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  stream(messages: LLMMessage[], options?: LLMRequestOptions): AsyncGenerator<LLMStreamChunk>;
}

export interface CodeGenerationRequest {
  prompt: string;
  context?: string;
  outputPath?: string;
  language?: string;
}

export interface CodeGenerationResult {
  files: GeneratedFile[];
  summary: string;
  tokensUsed?: number;
}

export interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}
