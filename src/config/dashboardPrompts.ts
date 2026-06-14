/**
 * Dashboard init prompts — loads the per-category default prompts from
 * editable Markdown files under prompts/dashboard/ and exposes them as consts
 * plus a single resolution helper.
 *
 * Files (prompts/dashboard/*.md):
 *   health.md, finance.md, grocery.md, custom.md  — one per board type
 *   agent-default.md  — agent `create` run with no --type and no --prompt
 *   fallback.md       — last-resort safety net when nothing else resolves
 *
 * Reads happen once at module load. A missing file degrades to the builtin
 * fallback instead of throwing, so a deleted/renamed prompt can never crash
 * the CLI or the test suite.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardConfig } from '../types/board.js';

/** The four dashboard categories that have preset prompts. */
export type DashboardType = BoardConfig['type'];

// Resolve repo root relative to this module's location.
// Dev (tsx): this file is at src/config/dashboardPrompts.ts → 2 levels up.
// Prod (tsup bundle): everything is in dist/index.js → 1 level up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = __dirname.includes('dist')
  ? resolve(__dirname, '..')
  : resolve(__dirname, '..', '..');
const PROMPTS_DIR = resolve(PROJECT_ROOT, 'prompts', 'dashboard');

/** Ultimate safety net if even fallback.md is missing. */
const BUILTIN_FALLBACK =
  'Create a clean, mobile-first analytics dashboard from this dataset: KPI summary cards for the key metrics, 2-3 charts that fit the data, and a short Insights section. Use a responsive layout and accessible chart labels.';

function readPrompt(file: string, fallback: string): string {
  try {
    const text = readFileSync(resolve(PROMPTS_DIR, file), 'utf-8').trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** Last-resort prompt, used as the guaranteed tail of every resolution branch. */
export const FINAL_FALLBACK_PROMPT = readPrompt('fallback.md', BUILTIN_FALLBACK);

/** Per-board-type default prompts. Empty file → FINAL_FALLBACK_PROMPT. */
export const DASHBOARD_PROMPTS: Record<DashboardType, string> = {
  health: readPrompt('health.md', FINAL_FALLBACK_PROMPT),
  finance: readPrompt('finance.md', FINAL_FALLBACK_PROMPT),
  grocery: readPrompt('grocery.md', FINAL_FALLBACK_PROMPT),
  custom: readPrompt('custom.md', FINAL_FALLBACK_PROMPT),
};

/** Used when an agent `create` run supplies neither --prompt nor --type. */
export const AGENT_DEFAULT_PROMPT = readPrompt('agent-default.md', FINAL_FALLBACK_PROMPT);

export interface ResolveInitialIntentArgs {
  /** Explicit user/agent prompt, if any. */
  userPrompt?: string;
  /** Board type (defaults to 'custom' for storage; only consulted when typeProvided). */
  type: DashboardType;
  /** Whether a type was explicitly selected (TUI preset or agent --type). */
  typeProvided: boolean;
}

/**
 * Single source of truth for choosing the initial generation intent:
 *   1. explicit userPrompt (trimmed, if non-empty)
 *   2. else, if a type was provided → that type's prompt
 *   3. else → the agent-default (no-type) prompt
 *   4. every branch falls back to FINAL_FALLBACK_PROMPT if it resolves empty.
 */
export function resolveInitialIntent({ userPrompt, type, typeProvided }: ResolveInitialIntentArgs): string {
  const explicit = userPrompt?.trim();
  if (explicit) return explicit;
  const byType = typeProvided ? DASHBOARD_PROMPTS[type] : AGENT_DEFAULT_PROMPT;
  return byType || FINAL_FALLBACK_PROMPT;
}
