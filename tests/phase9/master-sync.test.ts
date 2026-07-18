/**
 * Phase 9 — syncMasterTab behavior (the master "Overview" tab lifecycle):
 *  - generates only MasterDashboard.tsx via the LLM and stores the state hash
 *  - skips the LLM call when the dashboard set is unchanged and the component exists
 *  - deletes MasterDashboard.tsx and clears state when no dashboards remain
 *  - an LLM failure is non-fatal and leaves the stored state untouched (retry later)
 *  - disallowed file blocks (App.css) are skipped instead of aborting the write loop
 *
 * Uses a real TemplateService against a temp workspace so allowlist enforcement
 * is exercised for real; only the LLM provider is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BoardConfig } from '../../src/types/board.js';
import type { BoardRegistryService } from '../../src/services/project/BoardRegistryService.js';
import type { PromptHistoryService } from '../../src/services/project/PromptHistoryService.js';
import type { ProjectManager } from '../../src/services/project/ProjectManager.js';

const MASTER_CODE = [
  'Here is the master tab:',
  '//CODE_START',
  '--- FILE: App.tsx ---',
  'export default function App() { return null }',
  '--- END FILE ---',
  '--- FILE: components/MasterDashboard.tsx ---',
  'export function MasterDashboard() { return null }',
  '--- END FILE ---',
  '//CODE_END',
].join('\n');

const completeMock = vi.fn(async () => MASTER_CODE);
vi.mock('../../src/services/llm/LLMService.js', () => ({
  LLMService: { createProvider: () => ({ complete: completeMock }) },
}));

import { DashboardUpdateService } from '../../src/services/project/DashboardUpdateService.js';
import { RunStateService } from '../../src/services/project/RunStateService.js';
import { TemplateService } from '../../src/services/template/TemplateService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { PipelineReporter } from '../../src/services/project/pipelinePhases.js';

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: `board-${randomUUID().slice(0, 8)}`,
    name: 'dash',
    title: 'Dash',
    type: 'finance',
    outputDir: '',
    dataFiles: [],
    components: [],
    createdAt: new Date().toISOString(),
    dataSummary: 'columns: date, amount',
    ...overrides,
  };
}

function fakeRegistry(initial: BoardConfig[], sharedDir?: string) {
  let list = [...initial];
  let masterState: { hash: string; generatedAt: string } | undefined;
  return {
    listBoards: () => list,
    getSharedProjectDir: () => sharedDir,
    upsertBoard: vi.fn(),
    removeBoard: vi.fn(),
    getMasterState: () => masterState,
    setMasterState: vi.fn((state?: { hash: string; generatedAt: string }) => {
      masterState = state;
    }),
    setBoards: (boards: BoardConfig[]) => { list = boards; },
  };
}

describe('DashboardUpdateService.syncMasterTab', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'openboard-master-cfg-'));
  let workspace: string;
  let runsDir: string;

  beforeEach(() => {
    completeMock.mockReset();
    completeMock.mockResolvedValue(MASTER_CODE);
    workspace = mkdtempSync(join(tmpdir(), 'openboard-master-ws-'));
    runsDir = mkdtempSync(join(tmpdir(), 'openboard-master-runs-'));
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'App.tsx'), '// current app', 'utf-8');
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'phase9-master-secret';
    const cfg = new ConfigService();
    cfg.set('llm.provider', 'openai');
    cfg.set('llm.model', 'gpt-4o');
    cfg.set('llm.apiKey', 'sk-test');
  });

  afterEach(() => {
    for (const dir of [workspace, runsDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
    }
  });

  function makeService(registry: ReturnType<typeof fakeRegistry>) {
    return {
      service: new DashboardUpdateService(
        registry as unknown as BoardRegistryService,
        { append: vi.fn(), read: () => [], ensure: vi.fn(), delete: vi.fn() } as unknown as PromptHistoryService,
        {} as unknown as ProjectManager,
        new TemplateService(),
        undefined,
        new RunStateService(runsDir),
      ),
      registry,
    };
  }

  it('generates MasterDashboard.tsx, ignores App.tsx, and stores the master state hash', async () => {
    const { service, registry } = makeService(fakeRegistry([makeBoard()], workspace));
    const written = await service.syncMasterTab(workspace, new PipelineReporter());

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['components/MasterDashboard.tsx']);
    expect(existsSync(join(workspace, 'src', 'components', 'MasterDashboard.tsx'))).toBe(true);
    expect(readFileSync(join(workspace, 'src', 'App.tsx'), 'utf-8')).toBe('// current app');
    expect(registry.setMasterState).toHaveBeenCalledWith(
      expect.objectContaining({ hash: expect.any(String) }),
    );
    // The prompt carries the dashboard list without handing shell ownership to the LLM.
    const prompt = String(completeMock.mock.calls[0]?.[0]?.messages?.at(-1)?.content ?? '');
    expect(prompt).toContain('useAllDashboardsData');
    expect(prompt).toContain('Dash (slug: dash');
    expect(prompt).toContain('Return ONLY components/MasterDashboard.tsx');
  });

  it('skips the LLM call when the dashboard set is unchanged and the component exists', async () => {
    const { service } = makeService(fakeRegistry([makeBoard()], workspace));
    await service.syncMasterTab(workspace, new PipelineReporter());
    expect(completeMock).toHaveBeenCalledTimes(1);

    const written = await service.syncMasterTab(workspace, new PipelineReporter());
    expect(completeMock).toHaveBeenCalledTimes(1); // no second call
    expect(written).toEqual([]);
  });

  it('regenerates when the dashboard set changes', async () => {
    const registry = fakeRegistry([makeBoard({ name: 'a', title: 'A' })], workspace);
    const { service } = makeService(registry);
    await service.syncMasterTab(workspace, new PipelineReporter());

    registry.setBoards([makeBoard({ name: 'a', title: 'A' }), makeBoard({ name: 'b', title: 'B' })]);
    await service.syncMasterTab(workspace, new PipelineReporter());
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it('deletes MasterDashboard.tsx and clears the state when no dashboards remain', async () => {
    const registry = fakeRegistry([makeBoard()], workspace);
    const { service } = makeService(registry);
    await service.syncMasterTab(workspace, new PipelineReporter());
    expect(existsSync(join(workspace, 'src', 'components', 'MasterDashboard.tsx'))).toBe(true);

    registry.setBoards([]);
    const written = await service.syncMasterTab(workspace, new PipelineReporter());

    expect(written).toEqual([]);
    expect(existsSync(join(workspace, 'src', 'components', 'MasterDashboard.tsx'))).toBe(false);
    expect(registry.setMasterState).toHaveBeenLastCalledWith(undefined);
  });

  it('treats an LLM failure as non-fatal and leaves the stored state untouched', async () => {
    completeMock.mockRejectedValueOnce(new Error('provider down'));
    const registry = fakeRegistry([makeBoard()], workspace);
    const { service } = makeService(registry);

    const lines: string[] = [];
    const written = await service.syncMasterTab(workspace, new PipelineReporter((l) => lines.push(l)));

    expect(written).toEqual([]); // no throw
    expect(registry.setMasterState).not.toHaveBeenCalled(); // retried next operation
    expect(lines.join('\n')).toContain('master tab generation failed');

    // Next call retries the generation.
    await service.syncMasterTab(workspace, new PipelineReporter());
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(registry.setMasterState).toHaveBeenCalled();
  });

  it('skips disallowed file blocks (App.css) instead of aborting the whole write', async () => {
    completeMock.mockResolvedValueOnce([
      '//CODE_START',
      '--- FILE: App.css ---',
      'body { color: red }',
      '--- END FILE ---',
      '--- FILE: App.tsx ---',
      'export default function App() { return null }',
      '--- END FILE ---',
      '--- FILE: components/MasterDashboard.tsx ---',
      'export function MasterDashboard() { return null }',
      '--- END FILE ---',
      '//CODE_END',
    ].join('\n'));
    const { service } = makeService(fakeRegistry([makeBoard()], workspace));

    const written = await service.syncMasterTab(workspace, new PipelineReporter());

    expect(written).toEqual(['components/MasterDashboard.tsx']);
    expect(written).not.toContain('App.css');
    expect(existsSync(join(workspace, 'src', 'App.css'))).toBe(false); // shell-owned, not written
  });
});
