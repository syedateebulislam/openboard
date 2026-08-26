import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BoardConfig } from '../../src/types/board.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import {
  DashboardPromptService,
} from '../../src/services/project/DashboardPromptService.js';
import type { PromptHistoryEntry } from '../../src/services/project/PromptHistoryService.js';

function board(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: 'travel-board',
    name: 'uber-rides',
    title: 'Uber Rides',
    type: 'travel',
    outputDir: 'generated-app',
    dataFiles: ['uber.csv'],
    components: [],
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function entry(overrides: Partial<PromptHistoryEntry> = {}): PromptHistoryEntry {
  return {
    id: 'entry-1',
    boardId: 'travel-board',
    boardName: 'uber-rides',
    boardTitle: 'Uber Rides',
    source: 'initial',
    prompt: 'Generate the dashboard',
    writtenFiles: ['components/UberRidesDashboard.tsx'],
    createdAt: '2026-08-26T01:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardPromptService', () => {
  const tempDirs: string[] = [];

  function service(): DashboardPromptService {
    const dir = mkdtempSync(join(tmpdir(), 'openboard-prompt-profile-'));
    tempDirs.push(dir);
    return new DashboardPromptService(new ConfigService(dir));
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('selects the category prompt and persists dashboard additions below it', () => {
    const prompts = service();
    const target = board();
    const initial = prompts.profile(target);

    expect(initial.defaultSource).toBe('travel.md');
    expect(initial.defaultPrompt.length).toBeGreaterThan(100);
    expect(initial.appendedPrompt).toBe('');

    prompts.append(target.id, 'Prioritize median fare and flag sparse weeks.');
    const customized = prompts.profile(target);
    expect(customized.effectivePrompt).toContain(initial.defaultPrompt);
    expect(customized.effectivePrompt).toContain('ADDITIONAL DASHBOARD INSTRUCTIONS');
    expect(customized.effectivePrompt).toContain('Prioritize median fare');
    expect(customized.effectiveHash).not.toBe(initial.effectiveHash);
    expect(prompts.getCustomizationHistory(target.id)[0]).toMatchObject({ action: 'append' });
  });

  it('supports replace and clear without copying or changing the shipped default', () => {
    const prompts = service();
    const target = board();
    const defaultHash = prompts.profile(target).defaultHash;

    prompts.set(target.id, 'Only show verified city-level comparisons.');
    expect(prompts.profile(target).appendedPrompt).toBe('Only show verified city-level comparisons.');
    prompts.clear(target.id);

    const restored = prompts.profile(target);
    expect(restored.appendedPrompt).toBe('');
    expect(restored.defaultHash).toBe(defaultHash);
    expect(prompts.getCustomizationHistory(target.id).map((change) => change.action)).toEqual(['set', 'clear']);
  });

  it('reports legacy, current, then stale provenance as the prompt changes', () => {
    const prompts = service();
    const target = board();
    expect(prompts.auditStatus(target, [])).toMatchObject({ freshness: 'never-generated' });
    expect(prompts.auditStatus(target, [entry()])).toMatchObject({ freshness: 'legacy' });

    const messages = [
      { role: 'system' as const, content: prompts.profile(target).frameworkPrompt },
      { role: 'user' as const, content: prompts.composeRequestIntent(target) },
    ];
    const audited = entry({ promptAudit: prompts.createAudit(target, messages) });
    expect(prompts.auditStatus(target, [audited])).toMatchObject({ freshness: 'current' });

    prompts.append(target.id, 'Show airport versus city rides separately.');
    expect(prompts.auditStatus(target, [audited])).toMatchObject({ freshness: 'stale' });
    expect(prompts.historyReport(target, [audited])).toContain('CLI v');
  });

  it('uses the agent default only for boards created without an explicit type', () => {
    const prompts = service();
    expect(prompts.profile(board({ promptBase: 'agent-default' })).defaultSource).toBe('agent-default.md');
  });
});
