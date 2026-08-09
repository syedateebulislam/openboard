/**
 * App modes — the privacy contract the user picks before anything else.
 *
 * The mode is the FIRST choice OpenBoard asks for, so the user knows from the
 * beginning exactly what the end result is and what leaves their machine.
 *
 * A mode is a point on two independent axes — where generation runs, and where
 * the dashboard ends up — so the four modes are the full matrix:
 *
 *                | local preview only | GitHub + Vercel
 *   -------------+--------------------+-----------------
 *   local LLM    | local              | hybrid-local
 *   cloud LLM    | hybrid             | remote
 *
 * Consumers ask about an axis (`modeAllowsCloudLLM`, `modeAllowsDeploy`,
 * `allowedProvidersForMode`) instead of testing a mode id, so a fifth mode
 * would only need a row in APP_MODES.
 *
 * Single source of truth shared by the SetupWizard, the welcome/settings
 * screens, the in-chat command gating, the agentic pipeline, and
 * `openboard agent setup` — so every surface tells the same story.
 */

import { ConfigService } from '../services/config/ConfigService.js';
import type { LLMProviderName } from '../types/llm.js';
import { LLM_PROVIDER_NAMES } from './llmCatalog.js';

export type AppMode = 'local' | 'hybrid-local' | 'hybrid' | 'remote';

export const APP_MODE_IDS: AppMode[] = ['local', 'hybrid-local', 'hybrid', 'remote'];

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
  /** Where generation runs — the axis that decides which providers are offered. */
  llm: 'local' | 'cloud';
  /** Whether GitHub push and Vercel deploy are part of the pipeline. */
  deploy: boolean;
}

/**
 * Ordered privacy-first: the most private option is listed first, and the modes
 * that keep generation on the machine come before the ones that send prompts to
 * an LLM vendor.
 */
export const APP_MODES: AppModeInfo[] = [
  {
    id: 'local',
    label: 'Local only',
    summary: 'Local LLM (Ollama or LM Studio) + local preview only',
    detail: 'Nothing leaves your machine. No cloud LLM, no GitHub, no Vercel.',
    llm: 'local',
    deploy: false,
  },
  {
    id: 'hybrid-local',
    label: 'Hybrid (local LLM)',
    summary: 'Local LLM (Ollama or LM Studio) + GitHub + live Vercel web app',
    detail: 'Generation stays on your machine — no prompts or data summaries reach an LLM provider. Only the built dashboard and its data are pushed to GitHub and deployed.',
    llm: 'local',
    deploy: true,
  },
  {
    id: 'hybrid',
    label: 'Hybrid (cloud LLM)',
    summary: 'Cloud LLM (Codex/Claude/GPT/…) + local preview only',
    detail: 'Prompts and data summaries go to your LLM provider. No GitHub push, no live deployment.',
    llm: 'cloud',
    deploy: false,
  },
  {
    id: 'remote',
    label: 'All remote',
    summary: 'Cloud LLM (Codex/Claude/GPT/…) + GitHub + live Vercel web app',
    detail: 'Full pipeline: LLM generation, GitHub push, and a deployed dashboard URL.',
    llm: 'cloud',
    deploy: true,
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
  return appModeInfo(mode).llm === 'cloud';
}

/** Whether GitHub push and Vercel deploy are part of the pipeline. */
export function modeAllowsDeploy(mode: AppMode): boolean {
  return appModeInfo(mode).deploy;
}

const ALL_PROVIDERS: LLMProviderName[] = [...LLM_PROVIDER_NAMES];
const LOCAL_PROVIDERS: LLMProviderName[] = ['ollama', 'lmstudio'];
const CLOUD_PROVIDERS = ALL_PROVIDERS.filter(
  (provider) => !LOCAL_PROVIDERS.includes(provider),
);

/** LLM providers selectable in the given mode. */
export function allowedProvidersForMode(mode: AppMode): LLMProviderName[] {
  return appModeInfo(mode).llm === 'local' ? LOCAL_PROVIDERS : CLOUD_PROVIDERS;
}

export function providerAllowedInMode(provider: string, mode: AppMode): boolean {
  return (allowedProvidersForMode(mode) as string[]).includes(provider);
}

/**
 * The mode that keeps the current mode's publishing behavior but flips the LLM
 * axis — what to suggest when the user's provider and mode disagree.
 */
function modeWithOppositeLLM(mode: AppMode): AppModeInfo {
  const info = appModeInfo(mode);
  return APP_MODES.find((m) => m.deploy === info.deploy && m.llm !== info.llm)!;
}

/**
 * Message shown when the configured LLM provider is not allowed in the current
 * mode. Names the mode that already matches the user's provider so the fix is a
 * mode switch, not just a refusal.
 */
export function providerModeMismatchMessage(provider: string, mode: AppMode): string {
  const info = appModeInfo(mode);
  const alternative = modeWithOppositeLLM(mode);
  const allowed = allowedProvidersForMode(mode);
  const kind = info.llm === 'local'
    ? `${info.label} mode generates on your machine (${allowed.join(' or ')})`
    : `${info.label} mode lists cloud LLM providers only`;
  return (
    `LLM provider "${provider}" is not allowed in ${mode} mode — ${kind}. ` +
    `To keep "${provider}" with the same result, switch to ${alternative.label} (${alternative.summary}). ` +
    'Change the provider under Settings > Update LLM provider, or the mode under Settings > App mode.'
  );
}

/**
 * The deploying mode that keeps the user's current LLM axis — so a local-LLM
 * user is never told to start sending prompts to a cloud provider just to
 * publish a dashboard.
 */
export function deployModeSuggestion(mode: AppMode): AppModeInfo {
  return APP_MODES.find((m) => m.deploy && m.llm === appModeInfo(mode).llm)!;
}

/** Message shown when a remote-only action is blocked by the current mode. */
export function blockedDeployMessage(mode: AppMode, action: 'deploy' | 'push'): string {
  const info = appModeInfo(mode);
  const verb = action === 'deploy' ? 'Vercel deployment' : 'GitHub push';
  const target = deployModeSuggestion(mode);
  return [
    `${verb} is disabled in ${info.label} mode (${info.summary}).`,
    'Use /preview to view the dashboard locally.',
    `To publish a live web app, switch to ${target.label} mode in Settings > App mode.`,
  ].join('\n');
}
