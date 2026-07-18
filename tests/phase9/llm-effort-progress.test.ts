/**
 * Phase 9 — agent progress heartbeat + LLM model/effort selection:
 *  - startHeartbeat emits periodic liveness lines and stops cleanly
 *  - pipeline phase events carry step/totalSteps; step labels format as [X/8]
 *  - llmCatalog effort mapping (OpenAI reasoning_effort, Anthropic thinking
 *    budget, Codex model_reasoning_effort)
 *  - /model chat command parsing
 *  - SetupService configureLLM validates + persists --effort
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHeartbeat } from '../../src/services/llm/heartbeat.js';
import {
  LLM_EFFORTS,
  DEFAULT_EFFORT,
  isValidEffort,
  normalizeEffort,
  openaiReasoningEffort,
  anthropicThinkingBudget,
  codexReasoningEffort,
  normalizeCodexSubscriptionModel,
  MODEL_CHOICES,
  DEFAULT_MODELS,
} from '../../src/config/llmCatalog.js';
import {
  PipelineReporter,
  TOTAL_STEPS,
  phaseStep,
  phaseStepLabel,
} from '../../src/services/project/pipelinePhases.js';
import type { PipelineEvent } from '../../src/services/project/pipelinePhases.js';
import { parseCommand, CHAT_COMMANDS, HELP_TEXT } from '../../src/utils/commandParser.js';
import { SetupService } from '../../src/services/config/SetupService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';

describe('generation heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits periodic liveness lines and stops on demand', () => {
    const lines: string[] = [];
    const stop = startHeartbeat((line) => lines.push(line), 'openai (gpt-4o)', 1000);

    vi.advanceTimersByTime(3500);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('openai (gpt-4o) still generating');
    expect(lines[0]).toMatch(/\ds elapsed/);

    stop();
    vi.advanceTimersByTime(5000);
    expect(lines.length).toBe(3); // no lines after stop
  });

  it('is a no-op without an onProgress sink', () => {
    const stop = startHeartbeat(undefined, 'x', 10);
    vi.advanceTimersByTime(100);
    expect(() => stop()).not.toThrow();
  });
});

describe('pipeline step labels', () => {
  it('formats [step/total] labels for every phase', () => {
    expect(TOTAL_STEPS).toBe(8);
    expect(phaseStep('parse')).toBe(1);
    expect(phaseStep('generate')).toBe(3);
    expect(phaseStep('verify')).toBe(8);
    expect(phaseStep('done')).toBe(8); // done maps to the last working step
    expect(phaseStepLabel('generate')).toBe('[3/8] Generating dashboard code');
  });

  it('phase events carry step/totalSteps for orchestrators', () => {
    const events: PipelineEvent[] = [];
    const reporter = new PipelineReporter(undefined, (event) => events.push(event));
    reporter.phase('generate');
    reporter.log('working…');

    const phaseEvent = events.find((e) => e.event === 'phase');
    expect(phaseEvent?.step).toBe(3);
    expect(phaseEvent?.totalSteps).toBe(8);
    const logEvent = events.find((e) => e.event === 'log');
    expect(logEvent?.phase).toBe('generate');
  });
});

describe('llmCatalog effort mapping', () => {
  it('validates and normalizes effort values', () => {
    expect(LLM_EFFORTS).toEqual(['low', 'medium', 'high', 'max']);
    expect(isValidEffort('high')).toBe(true);
    expect(isValidEffort('turbo')).toBe(false);
    expect(normalizeEffort('max')).toBe('max');
    expect(normalizeEffort(undefined)).toBe(DEFAULT_EFFORT);
    expect(normalizeEffort('nonsense')).toBe(DEFAULT_EFFORT);
  });

  it('maps effort to OpenAI reasoning_effort only for reasoning models', () => {
    expect(openaiReasoningEffort('gpt-5.5', 'low')).toBe('low');
    expect(openaiReasoningEffort('o3-mini', 'max')).toBe('high'); // max caps at high
    expect(openaiReasoningEffort('gpt-4o', 'high')).toBeUndefined(); // non-reasoning
    expect(openaiReasoningEffort('gpt-5.5', undefined)).toBeUndefined();
  });

  it('maps effort to Anthropic thinking budgets (high/max only)', () => {
    expect(anthropicThinkingBudget('low', 'claude-sonnet-4-5')).toBeUndefined();
    expect(anthropicThinkingBudget('medium', 'claude-sonnet-4-5')).toBeUndefined();
    expect(anthropicThinkingBudget('high', 'claude-sonnet-4-5')).toBe(4096);
    expect(anthropicThinkingBudget('max', 'claude-sonnet-4-5')).toBe(10000);
    expect(anthropicThinkingBudget('high', 'claude-haiku-3-5')).toBeUndefined();
  });

  it('maps effort to the Codex CLI reasoning value', () => {
    expect(codexReasoningEffort('medium')).toBe('medium');
    expect(codexReasoningEffort('max')).toBe('high');
    expect(codexReasoningEffort(undefined)).toBeUndefined();
  });

  it('migrates the unsupported bare GPT-5.6 Codex alias', () => {
    expect(normalizeCodexSubscriptionModel('gpt-5.6')).toBe('gpt-5.6-terra');
    expect(normalizeCodexSubscriptionModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('has model choices and a default model for every provider', () => {
    for (const provider of Object.keys(DEFAULT_MODELS) as Array<keyof typeof DEFAULT_MODELS>) {
      expect(MODEL_CHOICES[provider].length).toBeGreaterThanOrEqual(8);
      expect(DEFAULT_MODELS[provider]).toBeTruthy();
      expect(MODEL_CHOICES[provider].some((choice) => choice.value === DEFAULT_MODELS[provider])).toBe(true);
    }
  });
});

describe('/model chat command', () => {
  it('parses /model with and without arguments', () => {
    expect(parseCommand('/model')).toEqual({ type: 'model', args: [] });
    expect(parseCommand('/model gpt-5.4 high')).toEqual({ type: 'model', args: ['gpt-5.4', 'high'] });
    expect(parseCommand('/model effort max')).toEqual({ type: 'model', args: ['effort', 'max'] });
  });

  it('is listed in the command palette and help text', () => {
    expect(CHAT_COMMANDS.some((c) => c.command === '/model')).toBe(true);
    expect(HELP_TEXT).toContain('/model');
  });
});

describe('SetupService configureLLM --effort', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-effort-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'phase9-effort-secret';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('persists a valid effort with the LLM config', async () => {
    const config = new ConfigService();
    const setup = new SetupService(config, {
      validateLLM: async () => ({ valid: true }),
    });
    const result = await setup.configureLLM({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'high',
      apiKey: 'sk-test',
    });

    expect(result.configured).toBe(true);
    expect(result.detail).toContain('effort: high');
    expect(config.get('llm.effort')).toBe('high');
    expect(setup.status().llm?.effort).toBe('high');
  });

  it('rejects an invalid effort value', async () => {
    const setup = new SetupService(new ConfigService(), {
      validateLLM: async () => ({ valid: true }),
    });
    const result = await setup.configureLLM({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'ultra',
      apiKey: 'sk-test',
    });

    expect(result.configured).toBe(false);
    expect(result.errorCode).toBe('E_VALIDATION');
    expect(result.error).toContain('low, medium, high, max');
  });
});
