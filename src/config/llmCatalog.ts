/**
 * LLM catalog — the single source of truth for provider model lists, default
 * models, and the execution-effort levels. Shared by the SetupWizard pickers,
 * the in-chat /model command, and `openboard agent setup` validation so all
 * three stay in sync.
 */

import type { LLMEffort, LLMProviderName } from '../types/llm.js';

export const LLM_EFFORTS: LLMEffort[] = ['low', 'medium', 'high', 'max'];

export const DEFAULT_EFFORT: LLMEffort = 'medium';

export function isValidEffort(value: unknown): value is LLMEffort {
  return typeof value === 'string' && (LLM_EFFORTS as string[]).includes(value);
}

/** Read + normalize an effort value from config/flags; falls back to medium. */
export function normalizeEffort(value: unknown): LLMEffort {
  return isValidEffort(value) ? value : DEFAULT_EFFORT;
}

export const EFFORT_CHOICES: Array<{ label: string; value: LLMEffort }> = [
  { label: 'Low — fastest and cheapest, lighter reasoning', value: 'low' },
  { label: 'Medium — balanced speed and quality (default)', value: 'medium' },
  { label: 'High — deeper reasoning, slower', value: 'high' },
  { label: 'Max — maximum reasoning effort, slowest', value: 'max' },
];

export const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  openai: 'gpt-4o',
  'openai-codex': 'gpt-5.5',
  anthropic: 'claude-sonnet-4-5',
  moonshot: 'moonshot-v1-128k',
  gemini: 'gemini-2.5-pro',
  ollama: 'qwen2.5-coder:7b',
};

/** Default model for a provider name from config/flags; unknown → openai's. */
export function defaultModelFor(provider: string): string {
  return DEFAULT_MODELS[provider as LLMProviderName] ?? DEFAULT_MODELS.openai;
}

export const MODEL_CHOICES: Record<LLMProviderName, Array<{ label: string; value: string }>> = {
  openai: [
    { label: 'GPT-4o (Latest, 128K context)', value: 'gpt-4o' },
    { label: 'GPT-4 Turbo (Fast, 128K context)', value: 'gpt-4-turbo' },
    { label: 'GPT-3.5 Turbo (Cheap, 16K context)', value: 'gpt-3.5-turbo' },
  ],
  'openai-codex': [
    { label: 'GPT-5.5 (Codex recommended)', value: 'gpt-5.5' },
    { label: 'GPT-5.4 (Codex)', value: 'gpt-5.4' },
    { label: 'GPT-5.4 Mini (Codex, fast)', value: 'gpt-5.4-mini' },
    { label: 'GPT-5.3 Codex', value: 'gpt-5.3-codex' },
  ],
  anthropic: [
    { label: 'Claude Opus 4.5 (Most capable, 200K)', value: 'claude-opus-4-5' },
    { label: 'Claude Sonnet 4.5 (Balanced, 200K)', value: 'claude-sonnet-4-5' },
    { label: 'Claude Haiku 3.5 (Fast, 200K)', value: 'claude-haiku-3-5' },
  ],
  moonshot: [
    { label: 'Kimi v1-128k (128K context)', value: 'moonshot-v1-128k' },
    { label: 'Kimi v1-32k (32K context)', value: 'moonshot-v1-32k' },
    { label: 'Kimi v1-8k (8K context)', value: 'moonshot-v1-8k' },
  ],
  gemini: [
    { label: 'Gemini 2.5 Pro (Most capable, 1M context — AI Pro plan)', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash (Fast, 1M context)', value: 'gemini-2.5-flash' },
    { label: 'Gemini 2.0 Flash (Fast, 1M context)', value: 'gemini-2.0-flash' },
  ],
  ollama: [
    // 🏆 Best for Code Generation
    { label: '🥇 Qwen2.5-Coder 7B (4.5GB) - Best code quality', value: 'qwen2.5-coder:7b' },
    { label: '🔥 DeepSeek-Coder-V2 16B (8.9GB) - Advanced coding', value: 'deepseek-coder-v2:16b' },
    { label: '💻 CodeLlama 13B (7.4GB) - Python/JS specialist', value: 'codellama:13b' },
    { label: '⚡ CodeLlama 7B (3.8GB) - Fast coding', value: 'codellama:7b' },
    { label: '🌏 Yi-Coder 9B (5.4GB) - Multilingual code', value: 'yi-coder:9b' },

    // 🎯 Best General Purpose
    { label: '🦙 Llama 3.1 8B (4.7GB) - Latest Meta model', value: 'llama3.1:8b' },
    { label: '🦙 Llama 3.2 3B (2GB) - Ultra compact', value: 'llama3.2:3b' },
    { label: '💎 Gemma2 9B (5.4GB) - Google\'s best', value: 'gemma2:9b' },
    { label: '🧠 Phi-3 Medium 14B (7.9GB) - Microsoft efficient', value: 'phi3:14b' },

    // ⚡ Best for Speed
    { label: '🚀 Mistral 7B (4.1GB) - Blazing fast', value: 'mistral:7b' },
    { label: '🏃 Phi-3 Mini (2.3GB) - Tiny powerhouse', value: 'phi3:mini' },
    { label: '⚡ Qwen2.5 7B (4.5GB) - Fast multilingual', value: 'qwen2.5:7b' },
  ],
};

// ── Effort → provider parameter mapping ─────────────────────────────────────
//
// | effort | OpenAI (reasoning models)  | Anthropic thinking | Codex CLI            |
// |--------|----------------------------|--------------------|----------------------|
// | low    | reasoning_effort: low      | off                | model_reasoning_effort=low    |
// | medium | reasoning_effort: medium   | off                | model_reasoning_effort=medium |
// | high   | reasoning_effort: high     | budget 4096        | model_reasoning_effort=high   |
// | max    | reasoning_effort: high     | budget 10000       | model_reasoning_effort=high   |
//
// Gemini / Moonshot / Ollama have no comparable knob today — effort is a
// documented no-op there (only the heartbeat applies).

/**
 * OpenAI `reasoning_effort` for reasoning-capable models (o-series / gpt-5*).
 * Returns undefined for non-reasoning models (which reject the parameter).
 */
export function openaiReasoningEffort(
  model: string,
  effort: LLMEffort | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  if (!/^(o\d|gpt-5)/i.test(model)) return undefined;
  return effort === 'max' ? 'high' : effort;
}

/**
 * Anthropic extended-thinking token budget. Only high/max enable thinking;
 * low/medium keep the fast default path. Returns undefined for models that do
 * not support extended thinking (generation < 4, e.g. claude-haiku-3-5) —
 * sending `thinking` to those models is a 400 on every call.
 */
export function anthropicThinkingBudget(
  effort: LLMEffort | undefined,
  model: string,
): number | undefined {
  if (!/-[4-9]-\d/.test(model)) return undefined;
  if (effort === 'high') return 4096;
  if (effort === 'max') return 10000;
  return undefined;
}

/** Codex CLI `model_reasoning_effort` config value. */
export function codexReasoningEffort(effort: LLMEffort | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  return effort === 'max' ? 'high' : effort;
}
