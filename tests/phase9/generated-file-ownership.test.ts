import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BoardConfig } from '../../src/types/board.js';
import type { BoardRegistryService } from '../../src/services/project/BoardRegistryService.js';
import type { PromptHistoryService } from '../../src/services/project/PromptHistoryService.js';
import type { ProjectManager } from '../../src/services/project/ProjectManager.js';

const completeMock = vi.fn();
vi.mock('../../src/services/llm/LLMService.js', () => ({
  LLMService: { createProvider: () => ({ complete: completeMock }) },
}));
vi.mock('../../src/services/build/BuildService.js', () => ({
  BuildService: { validateGeneratedCode: vi.fn(async () => ({ success: true, errors: [] })) },
}));

import { ConfigService } from '../../src/services/config/ConfigService.js';
import { DashboardUpdateService } from '../../src/services/project/DashboardUpdateService.js';
import { PipelineReporter } from '../../src/services/project/pipelinePhases.js';
import { RunStateService } from '../../src/services/project/RunStateService.js';
import { TemplateService } from '../../src/services/template/TemplateService.js';

function board(overrides: Partial<BoardConfig>): BoardConfig {
  return {
    id: 'uber',
    name: 'uber-rides',
    title: 'Uber Rides',
    type: 'travel',
    outputDir: '',
    dataFiles: [],
    components: ['components/UberRidesDashboard.tsx'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('generated dashboard file ownership', () => {
  let workspace: string;
  let runsDir: string;
  let boards: BoardConfig[];
  let registry: Record<string, unknown>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'openboard-ownership-'));
    runsDir = mkdtempSync(join(tmpdir(), 'openboard-ownership-runs-'));
    mkdirSync(join(workspace, 'src', 'components'), { recursive: true });
    mkdirSync(join(workspace, 'src', 'utils'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'components', 'UberRidesDashboard.tsx'), 'export const Uber = "old";\n');
    writeFileSync(join(workspace, 'src', 'components', 'RapidoDashboard.tsx'), 'export const Rapido = true;\n');
    writeFileSync(join(workspace, 'src', 'utils', 'travelData.ts'), 'export const rapidoContract = true;\n');

    boards = [
      board({ id: 'rapido', name: 'rapido', title: 'Rapido', outputDir: workspace, components: ['components/RapidoDashboard.tsx', 'utils/travelData.ts'] }),
      board({ outputDir: workspace }),
    ];
    let masterState: { hash: string; generatedAt: string } | undefined;
    registry = {
      listBoards: () => boards,
      getSharedProjectDir: () => workspace,
      getMasterState: () => masterState,
      setMasterState: (state?: { hash: string; generatedAt: string }) => { masterState = state; },
      upsertBoard: (value: BoardConfig) => {
        boards = boards.map((candidate) => candidate.id === value.id ? value : candidate);
        return boards;
      },
      replaceBoards: vi.fn((value: BoardConfig[]) => {
        boards = [...value];
        return boards;
      }),
    };

    process.env.OPENBOARD_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openboard-ownership-config-'));
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'ownership-test-secret';
    const config = new ConfigService();
    config.set('llm.provider', 'openai');
    config.set('llm.model', 'gpt-4o');
    config.set('llm.apiKey', 'sk-test');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  function service(projectManager: Partial<ProjectManager> = {}) {
    return new DashboardUpdateService(
      registry as unknown as BoardRegistryService,
      { read: () => [], append: vi.fn() } as unknown as PromptHistoryService,
      projectManager as ProjectManager,
      new TemplateService(),
      undefined,
      new RunStateService(runsDir),
    );
  }

  it('skips a helper owned by Rapido while allowing the Uber component update', async () => {
    completeMock.mockResolvedValueOnce([
      '//CODE_START',
      '--- FILE: utils/travelData.ts ---',
      'export const incompatibleUberContract = true;',
      '--- END FILE ---',
      '--- FILE: components/UberRidesDashboard.tsx ---',
      'export const Uber = "new";',
      '--- END FILE ---',
      '//CODE_END',
    ].join('\n'));
    const lines: string[] = [];
    const target = boards[1];
    const written = await (service() as any).generateAndWriteFiles(
      target,
      'refresh Uber',
      new PipelineReporter((line) => lines.push(line)),
    );

    expect(written).toEqual(['components/UberRidesDashboard.tsx']);
    expect(readFileSync(join(workspace, 'src', 'utils', 'travelData.ts'), 'utf-8')).toContain('rapidoContract');
    expect(readFileSync(join(workspace, 'src', 'components', 'UberRidesDashboard.tsx'), 'utf-8')).toContain('"new"');
    expect(lines.join('\n')).toContain('owned by dashboard "Rapido"');
    const system = String(completeMock.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
    expect(system).toContain('utils/travelData.ts');
    expect(system).toContain('"uber-rides/" subdirectory');
  });

  it('restores generated files and registry state when the final build fails', async () => {
    completeMock
      .mockResolvedValueOnce([
        '//CODE_START',
        '--- FILE: components/UberRidesDashboard.tsx ---',
        'export const Uber = "broken";',
        '--- END FILE ---',
        '//CODE_END',
      ].join('\n'))
      .mockResolvedValue('');
    const projectManager = {
      getProjectInfo: vi.fn(() => ({ hasNodeModules: true })),
      build: vi.fn(async () => ({ success: false, error: 'bad import' })),
    };
    const target = boards[1];
    const updateService = service(projectManager);
    const reporter = new PipelineReporter();
    const written = await (updateService as any).generateAndWriteFiles(target, 'refresh Uber', reporter);
    (registry.upsertBoard as (value: BoardConfig) => BoardConfig[])({
      ...target,
      components: [...target.components, 'utils/travelData.ts'],
    });

    const result = await (updateService as any).buildPushDeploy(target, written, 'test', reporter);

    expect(result.success).toBe(false);
    expect(readFileSync(join(workspace, 'src', 'components', 'UberRidesDashboard.tsx'), 'utf-8')).toContain('"old"');
    expect(boards.find((candidate) => candidate.id === 'uber')?.components).toEqual(['components/UberRidesDashboard.tsx']);
    expect(registry.replaceBoards).toHaveBeenCalledTimes(1);
  });
});
