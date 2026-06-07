/**
 * PHASE 2: LLMService Tests
 *
 * Tests the provider factory facade. Since providers require real API keys /
 * running servers, we test the factory routing and error handling only.
 */

import { describe, it, expect } from 'vitest';
import { LLMService } from '../../src/services/llm/LLMService.js';

describe('LLMService', () => {
  describe('Provider Factory', () => {
    it('should create OpenAIProvider for openai config', () => {
      const provider = LLMService.createProvider({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
      });
      expect(provider.name).toBe('openai');
    });

    it('should create OpenAICodexProvider for openai-codex config without apiKey', () => {
      const provider = LLMService.createProvider({
        provider: 'openai-codex',
        model: 'gpt-5.5',
      });
      expect(provider.name).toBe('openai-codex');
    });

    it('should create AnthropicProvider for anthropic config', () => {
      const provider = LLMService.createProvider({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-ant-test-key',
      });
      expect(provider.name).toBe('anthropic');
    });

    it('should create OllamaProvider for ollama config', () => {
      const provider = LLMService.createProvider({
        provider: 'ollama',
        model: 'llama3',
        ollamaHost: 'http://127.0.0.1:11434',
      });
      expect(provider.name).toBe('ollama');
    });

    it('should create MoonshotProvider for moonshot config', () => {
      const provider = LLMService.createProvider({
        provider: 'moonshot',
        model: 'moonshot-v1-8k',
        apiKey: 'sk-moonshot-test',
      });
      expect(provider.name).toBe('moonshot');
    });

    it('should throw for unknown provider', () => {
      expect(() =>
        LLMService.createProvider({
          provider: 'unknown' as any,
          model: 'test',
        }),
      ).toThrow(/Unknown LLM provider/i);
    });

    it('should throw when OpenAI provider is missing apiKey', () => {
      expect(() =>
        LLMService.createProvider({ provider: 'openai' }),
      ).toThrow(/requires an apiKey/i);
    });

    it('should throw when Anthropic provider is missing apiKey', () => {
      expect(() =>
        LLMService.createProvider({ provider: 'anthropic' }),
      ).toThrow(/requires an apiKey/i);
    });

    it('should throw when Moonshot provider is missing apiKey', () => {
      expect(() =>
        LLMService.createProvider({ provider: 'moonshot' }),
      ).toThrow(/requires an apiKey/i);
    });

    it('should use default model for OpenAI when not specified', () => {
      const provider = LLMService.createProvider({
        provider: 'openai',
        apiKey: 'sk-test',
      });
      expect(provider.name).toBe('openai');
    });

    it('should use default host for Ollama when not specified', () => {
      const provider = LLMService.createProvider({
        provider: 'ollama',
      });
      expect(provider.name).toBe('ollama');
    });
  });
});
