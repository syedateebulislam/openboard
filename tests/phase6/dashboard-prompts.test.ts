/**
 * PHASE 6: Dashboard init prompts
 *
 * Validates the externalized prompt loader (prompts/dashboard/*.md) and the
 * resolveInitialIntent resolution chain.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DASHBOARD_PROMPTS,
  AGENT_DEFAULT_PROMPT,
  FINAL_FALLBACK_PROMPT,
  resolveInitialIntent,
} from '../../src/config/dashboardPrompts.js';

const PROMPTS_DIR = join(process.cwd(), 'prompts', 'dashboard');

describe('Dashboard init prompts', () => {
  describe('prompt files', () => {
    it('should ship a markdown file for every category, agent-default, and fallback', () => {
      for (const file of ['health.md', 'finance.md', 'grocery.md', 'custom.md', 'agent-default.md', 'fallback.md']) {
        expect(existsSync(join(PROMPTS_DIR, file)), `missing ${file}`).toBe(true);
        expect(readFileSync(join(PROMPTS_DIR, file), 'utf-8').trim().length).toBeGreaterThan(0);
      }
    });

    it('should load every category prompt as a non-empty string', () => {
      for (const type of ['health', 'finance', 'grocery', 'custom'] as const) {
        expect(DASHBOARD_PROMPTS[type].length).toBeGreaterThan(0);
      }
      expect(AGENT_DEFAULT_PROMPT.length).toBeGreaterThan(0);
      expect(FINAL_FALLBACK_PROMPT.length).toBeGreaterThan(0);
    });

    it('should match finance file contents to the loaded finance prompt', () => {
      const fromFile = readFileSync(join(PROMPTS_DIR, 'finance.md'), 'utf-8').trim();
      expect(DASHBOARD_PROMPTS.finance).toBe(fromFile);
    });
  });

  describe('resolveInitialIntent', () => {
    it('should prefer an explicit user prompt over everything', () => {
      const intent = resolveInitialIntent({ userPrompt: '  Build a churn dashboard  ', type: 'finance', typeProvided: true });
      expect(intent).toBe('Build a churn dashboard');
    });

    it('should use the category prompt when a type was provided and no user prompt', () => {
      expect(resolveInitialIntent({ userPrompt: undefined, type: 'health', typeProvided: true }))
        .toBe(DASHBOARD_PROMPTS.health);
      expect(resolveInitialIntent({ userPrompt: '   ', type: 'grocery', typeProvided: true }))
        .toBe(DASHBOARD_PROMPTS.grocery);
    });

    it('should use the agent-default prompt when no type was provided', () => {
      expect(resolveInitialIntent({ userPrompt: undefined, type: 'custom', typeProvided: false }))
        .toBe(AGENT_DEFAULT_PROMPT);
    });

    it('should never return an empty string', () => {
      const intent = resolveInitialIntent({ userPrompt: '', type: 'custom', typeProvided: false });
      expect(intent.length).toBeGreaterThan(0);
    });
  });
});
