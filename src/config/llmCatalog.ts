/**
 * LLM catalog — shared by setup, settings, chat commands, and headless setup.
 *
 * Curated from provider documentation on 2026-07-18. Each provider exposes
 * eight recent text/code choices. Provider model APIs remain the authority for
 * account/region-specific availability.
 */

import type { LLMEffort, LLMProviderName } from '../types/llm.js';

export interface LLMProviderChoice {
  label: string;
  value: LLMProviderName;
  auth: 'subscription' | 'api-key' | 'local';
}

export const LLM_PROVIDER_CHOICES: LLMProviderChoice[] = [
  { label: '(Subscription) OpenAI Codex / ChatGPT — browser login', value: 'openai-codex', auth: 'subscription' },
  { label: 'OpenAI API — GPT-5.6 family', value: 'openai', auth: 'api-key' },
  { label: 'Anthropic API — Claude 5 / 4.x', value: 'anthropic', auth: 'api-key' },
  { label: 'Google AI Studio API — Gemini 3.x / 2.5', value: 'gemini', auth: 'api-key' },
  { label: 'Moonshot API — Kimi', value: 'moonshot', auth: 'api-key' },
  { label: 'xAI API — Grok', value: 'xai', auth: 'api-key' },
  { label: 'Mistral AI API — Mistral / Devstral', value: 'mistral', auth: 'api-key' },
  { label: 'OpenRouter API — leading labs through one key', value: 'openrouter', auth: 'api-key' },
  { label: '(Local) LM Studio — downloaded GGUF/MLX models', value: 'lmstudio', auth: 'local' },
  { label: '(Local) Ollama — open-weight models on your machine', value: 'ollama', auth: 'local' },
];

export const LLM_PROVIDER_NAMES = LLM_PROVIDER_CHOICES.map((provider) => provider.value);

export const LLM_EFFORTS: LLMEffort[] = ['low', 'medium', 'high', 'max'];
export const DEFAULT_EFFORT: LLMEffort = 'medium';

export function isValidEffort(value: unknown): value is LLMEffort {
  return typeof value === 'string' && (LLM_EFFORTS as string[]).includes(value);
}

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
  openai: 'gpt-5.6-terra',
  'openai-codex': 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.5-flash',
  moonshot: 'kimi-k3',
  xai: 'grok-4.5',
  mistral: 'mistral-medium-latest',
  openrouter: 'openai/gpt-5.6-terra',
  lmstudio: '__auto__',
  ollama: 'qwen3.5:9b',
};

export function defaultModelFor(provider: string): string {
  return DEFAULT_MODELS[provider as LLMProviderName] ?? DEFAULT_MODELS.openai;
}

type ModelChoice = { label: string; value: string };

export const MODEL_CHOICES: Record<LLMProviderName, ModelChoice[]> = {
  openai: [
    { label: 'GPT-5.6 Sol — flagship reasoning and coding', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.6 Terra — balanced (recommended)', value: 'gpt-5.6-terra' },
    { label: 'GPT-5.6 Luna — economical and high-volume', value: 'gpt-5.6-luna' },
    { label: 'GPT-5.6 — latest flagship alias', value: 'gpt-5.6' },
    { label: 'GPT-5.4 — strong professional work', value: 'gpt-5.4' },
    { label: 'GPT-5.4 Mini — faster and lower cost', value: 'gpt-5.4-mini' },
    { label: 'GPT-5.3 Codex — coding specialist', value: 'gpt-5.3-codex' },
    { label: 'GPT-5.2 — previous flagship', value: 'gpt-5.2' },
  ],
  'openai-codex': [
    { label: 'GPT-5.6 Sol — highest-capability Codex model', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.6 Terra — balanced intelligence and cost', value: 'gpt-5.6-terra' },
    { label: 'GPT-5.6 Luna — fast and economical', value: 'gpt-5.6-luna' },
    { label: 'GPT-5.5 — high-capability coding', value: 'gpt-5.5' },
    { label: 'GPT-5.4 — agentic coding', value: 'gpt-5.4' },
    { label: 'GPT-5.4 Mini — fast coding', value: 'gpt-5.4-mini' },
    { label: 'GPT-5.3 Codex — coding specialist', value: 'gpt-5.3-codex' },
    { label: 'GPT-5.2 Codex — previous coding model', value: 'gpt-5.2-codex' },
  ],
  anthropic: [
    { label: 'Claude Fable 5 — highest capability', value: 'claude-fable-5' },
    { label: 'Claude Opus 4.8 — complex agentic coding', value: 'claude-opus-4-8' },
    { label: 'Claude Sonnet 5 — speed + intelligence (recommended)', value: 'claude-sonnet-5' },
    { label: 'Claude Haiku 4.5 — fastest', value: 'claude-haiku-4-5' },
    { label: 'Claude Opus 4.7 — previous Opus', value: 'claude-opus-4-7' },
    { label: 'Claude Opus 4.6 — long-context reasoning', value: 'claude-opus-4-6' },
    { label: 'Claude Sonnet 4.6 — balanced previous generation', value: 'claude-sonnet-4-6' },
    { label: 'Claude Sonnet 4.5 — stable coding model', value: 'claude-sonnet-4-5' },
  ],
  gemini: [
    { label: 'Gemini 3.5 Flash — stable agentic/coding model', value: 'gemini-3.5-flash' },
    { label: 'Gemini 3.1 Pro Preview — advanced reasoning', value: 'gemini-3.1-pro-preview' },
    { label: 'Gemini Pro Latest — newest Pro alias', value: 'gemini-pro-latest' },
    { label: 'Gemini Flash Latest — newest Flash alias', value: 'gemini-flash-latest' },
    { label: 'Gemini Flash-Lite Latest — newest budget alias', value: 'gemini-flash-lite-latest' },
    { label: 'Gemini 2.5 Pro — stable deep reasoning', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash — stable price/performance', value: 'gemini-2.5-flash' },
    { label: 'Gemini 2.5 Flash-Lite — stable low latency', value: 'gemini-2.5-flash-lite' },
  ],
  moonshot: [
    { label: 'Kimi K3 — newest 1M-context flagship', value: 'kimi-k3' },
    { label: 'Kimi K2.7 Code — dedicated coding model', value: 'kimi-k2.7-code' },
    { label: 'Kimi K2.7 Code Highspeed — up to 260 tok/s', value: 'kimi-k2.7-code-highspeed' },
    { label: 'Kimi K2.6 — multimodal reasoning and agents', value: 'kimi-k2.6' },
    { label: 'Kimi K2.5 — previous multimodal agent', value: 'kimi-k2.5' },
    { label: 'Moonshot v1 128K — legacy long context', value: 'moonshot-v1-128k' },
    { label: 'Moonshot v1 32K — compact context', value: 'moonshot-v1-32k' },
    { label: 'Moonshot v1 8K — short text', value: 'moonshot-v1-8k' },
  ],
  xai: [
    { label: 'Grok 4.5 — newest coding/agentic flagship', value: 'grok-4.5' },
    { label: 'Grok 4.3 — fast general reasoning', value: 'grok-4.3' },
    { label: 'Grok Build 0.1 — agentic coding', value: 'grok-build-0.1' },
    { label: 'Grok 4.20 Reasoning — deep reasoning', value: 'grok-4.20-reasoning' },
    { label: 'Grok 4.20 — general model', value: 'grok-4.20' },
    { label: 'Grok 4.1 Fast Reasoning — compatibility alias', value: 'grok-4-1-fast-reasoning' },
    { label: 'Grok 4 Fast Reasoning — compatibility alias', value: 'grok-4-fast-reasoning' },
    { label: 'Grok 3 — compatibility alias', value: 'grok-3' },
  ],
  mistral: [
    { label: 'Mistral Medium 3.5 — latest frontier model', value: 'mistral-medium-latest' },
    { label: 'Mistral Small 4 — efficient hybrid model', value: 'mistral-small-latest' },
    { label: 'Mistral Large 3 — open-weight flagship', value: 'mistral-large-latest' },
    { label: 'Devstral 2 — software engineering agents', value: 'devstral-latest' },
    { label: 'Devstral Small 2 — efficient coding agent', value: 'devstral-small-latest' },
    { label: 'Magistral Medium 1.2 — reasoning', value: 'magistral-medium-latest' },
    { label: 'Magistral Small 1.2 — open reasoning', value: 'magistral-small-latest' },
    { label: 'Codestral — code generation/completion', value: 'codestral-latest' },
  ],
  openrouter: [
    { label: 'OpenAI GPT-5.6 Terra — balanced frontier', value: 'openai/gpt-5.6-terra' },
    { label: 'Anthropic Claude Sonnet 5 — fast frontier', value: 'anthropic/claude-sonnet-5' },
    { label: 'Google Gemini 3.5 Flash — agentic/coding', value: 'google/gemini-3.5-flash' },
    { label: 'xAI Grok 4.5 — coding and knowledge work', value: 'x-ai/grok-4.5' },
    { label: 'DeepSeek V4 Pro — open reasoning/coding', value: 'deepseek/deepseek-v4-pro' },
    { label: 'Mistral Medium 3.5 — frontier multimodal', value: 'mistralai/mistral-medium-3.5' },
    { label: 'Qwen 3.5 — open multimodal agent', value: 'qwen/qwen3.5-397b-a17b' },
    { label: 'OpenAI GPT-OSS 120B — open-weight reasoning', value: 'openai/gpt-oss-120b' },
  ],
  lmstudio: [
    { label: 'Auto — first LLM exposed by LM Studio (recommended)', value: '__auto__' },
    { label: 'OpenAI GPT-OSS 20B — local reasoning (16GB+ RAM)', value: 'openai/gpt-oss-20b' },
    { label: 'Qwen 3.5 9B — balanced coding and reasoning', value: 'qwen/qwen3.5-9b' },
    { label: 'Qwen 3 Coder 30B — agentic coding', value: 'qwen/qwen3-coder-30b' },
    { label: 'Google Gemma 3 12B — multimodal general model', value: 'google/gemma-3-12b' },
    { label: 'Mistral Small 3.2 24B — tool use and coding', value: 'mistralai/mistral-small-3.2-24b' },
    { label: 'DeepSeek R1 Distill Qwen 14B — reasoning', value: 'deepseek/deepseek-r1-distill-qwen-14b' },
    { label: 'Microsoft Phi-4 14B — compact reasoning', value: 'microsoft/phi-4' },
  ],
  ollama: [
    { label: 'Qwen 3.5 9B (6.6GB) — balanced local default', value: 'qwen3.5:9b' },
    { label: 'Qwen 3.5 4B (3.4GB) — compact multimodal', value: 'qwen3.5:4b' },
    { label: 'Qwen 3 Coder 30B — agentic coding', value: 'qwen3-coder:30b' },
    { label: 'OpenAI GPT-OSS 20B (14GB) — local reasoning', value: 'gpt-oss:20b' },
    { label: 'OpenAI GPT-OSS 120B — workstation/server reasoning', value: 'gpt-oss:120b' },
    { label: 'Google Gemma 3 4B (3.3GB) — compact multimodal', value: 'gemma3:4b' },
    { label: 'Google Gemma 3 12B (8.1GB) — balanced multimodal', value: 'gemma3:12b' },
    { label: 'Google Gemma 3 27B (17GB) — highest Gemma quality', value: 'gemma3:27b' },
    { label: 'Mistral Small 3.2 24B (15GB) — tools and coding', value: 'mistral-small3.2:24b' },
    { label: 'Mistral Nemo 12B — efficient 128K context', value: 'mistral-nemo:12b' },
    { label: 'DeepSeek R1 8B — compact reasoning', value: 'deepseek-r1:8b' },
    { label: 'DeepSeek R1 14B — balanced reasoning', value: 'deepseek-r1:14b' },
    { label: 'DeepSeek R1 32B — stronger reasoning', value: 'deepseek-r1:32b' },
    { label: 'Meta Llama 4 Scout — multimodal MoE', value: 'llama4:scout' },
    { label: 'Microsoft Phi-4 14B — compact reasoning', value: 'phi4:14b' },
    { label: 'Devstral 24B — Mistral software engineering', value: 'devstral:24b' },
  ],
};

export function openaiReasoningEffort(model: string, effort: LLMEffort | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!effort || !/^(o\d|gpt-5)/i.test(model)) return undefined;
  return effort === 'max' ? 'high' : effort;
}

export function anthropicThinkingBudget(effort: LLMEffort | undefined, model: string): number | undefined {
  // Claude 4.6+ and Claude 5 use adaptive thinking/effort rather than the
  // legacy `thinking: { type: enabled }` request used by this provider.
  if (!/-4-5/.test(model)) return undefined;
  if (effort === 'high') return 4096;
  if (effort === 'max') return 10000;
  return undefined;
}

export function codexReasoningEffort(effort: LLMEffort | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  return effort === 'max' ? 'high' : effort;
}

/**
 * Migrate model aliases that the API catalog may expose but ChatGPT-backed
 * Codex does not accept. Existing OpenBoard configs can contain the old bare
 * `gpt-5.6` value, so normalize it at runtime instead of breaking regeneration.
 */
export function normalizeCodexSubscriptionModel(model: string): string {
  return model === 'gpt-5.6' ? DEFAULT_MODELS['openai-codex'] : model;
}
