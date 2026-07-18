/**
 * App modes — the privacy contract the user picks before anything else.
 *
 * The mode is the FIRST choice OpenBoard asks for, so the user knows from the
 * beginning exactly what the end result is and what leaves their machine:
 *
 *   1. local  — Local only:  local LLM (Ollama) + local preview.
 *               Nothing leaves the machine.
 *   2. hybrid — Cloud LLM (Codex/Claude/GPT/…) + local preview only.
 *               Prompts and data summaries go to the LLM provider;
 *               no GitHub push, no live deployment.
 *   3. remote — All remote:  cloud LLM + GitHub push + live Vercel web app.
 *
 * Single source of truth shared by the SetupWizard, the welcome/settings
 * screens, the in-chat command gating, the agentic pipeline, and
 * `openboard agent setup` — so every surface tells the same story.
 */

import { ConfigService } from '../services/config/ConfigService.js';
import type { LLMProviderName } from '../types/llm.js';

export type AppMode = 'local' | 'hybrid' | 'remote';

export const APP_MODE_IDS: AppMode[] = ['local', 'hybrid', 'remote'];

/** Existing installs predate modes and always had the full pipeline. */
export const DEFAULT_APP_MODE: AppMode = 'remote';

export interface AppModeInfo {
  id: AppMode;
  /** Short menu label, e.g. "Local only". */
  label: string;
  /** One-line "what you get at the end". */
  summary: string;
  /** Privacy detail shown under the option. */
  detail: string;
}

/** Ordered privacy-first: the most private option is always listed first. */
export const APP_MODES: AppModeInfo[] = [
  {
    id: 'local',
    label: 'Local only',
    summary: 'Local LLM (Ollama) + local preview only',
    detail: 'Nothing leaves your machine. No cloud LLM, no GitHub, no Vercel.',
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    summary: 'Cloud LLM (Codex/Claude/GPT/…) + local preview only',
    detail: 'Prompts and data summaries go to your LLM provider. No GitHub push, no live deployment.',
  },
  {
    id: 'remote',
    label: 'All remote',
    summary: 'Cloud LLM + GitHub + live Vercel web app',
    detail: 'Full pipeline: LLM generation, GitHub push, and a deployed dashboard URL.',
  },
];

export function isValidAppMode(value: unknown): value is AppMode {
  return typeof value === 'string' && (APP_MODE_IDS as string[]).includes(value);
}

export function appModeInfo(mode: AppMode): AppModeInfo {
  return APP_MODES.find((m) => m.id === mode)!;
}

/** One-line description used in banners/status output. */
export function describeAppMode(mode: AppMode): string {
  const info = appModeInfo(mode);
  return `${info.label} — ${info.summary}`;
}

/** Read the configured mode; unset configs keep today's full-pipeline behavior. */
export function getAppMode(config = new ConfigService()): AppMode {
  const value = config.get('app.mode');
  return isValidAppMode(value) ? value : DEFAULT_APP_MODE;
}

export function setAppMode(mode: AppMode, config = new ConfigService()): void {
  config.set('app.mode', mode);
}

/** Whether prompts/data summaries may be sent to a cloud LLM provider. */
export function modeAllowsCloudLLM(mode: AppMode): boolean {
  return mode !== 'local';
}

/** Whether GitHub push and Vercel deploy are part of the pipeline. */
export function modeAllowsDeploy(mode: AppMode): boolean {
  return mode === 'remote';
}

const ALL_PROVIDERS: LLMProviderName[] = ['openai', 'openai-codex', 'anthropic', 'moonshot', 'gemini', 'ollama'];

/** LLM providers selectable in the given mode. */
export function allowedProvidersForMode(mode: AppMode): LLMProviderName[] {
  return modeAllowsCloudLLM(mode) ? ALL_PROVIDERS : ['ollama'];
}

export function providerAllowedInMode(provider: string, mode: AppMode): boolean {
  return (allowedProvidersForMode(mode) as string[]).includes(provider);
}

/** Message shown when a remote-only action is blocked by the current mode. */
export function blockedDeployMessage(mode: AppMode, action: 'deploy' | 'push'): string {
  const info = appModeInfo(mode);
  const verb = action === 'deploy' ? 'Vercel deployment' : 'GitHub push';
  return [
    `${verb} is disabled in ${info.label} mode (${info.summary}).`,
    'Use /preview to view the dashboard locally.',
    'To publish a live web app, switch to All remote mode in Settings > App mode.',
  ].join('\n');
}
