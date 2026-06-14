/**
 * Phase 9 — bulk dashboard operations:
 *  - updateAllWithPrompt: apply one prompt to every dashboard, deploy ONCE
 *  - removeAllDashboards: reset app to shell, clear registry, deploy ONCE
 *  - TemplateService.restoreAppShell: deterministic empty-shell reset
 *
 * The real orchestration runs; only the LLM provider is stubbed (no network,
 * no API key) and build/push/deploy are faked so the deploy-once invariant and
 * registry/state effects can be asserted without a real workspace.
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
import type { TemplateService } from '../../src/services/template/TemplateService.js';

// Stub the LLM so generation returns a valid //CODE_START block without network.
const VALID_CODE = [
  '//CODE_START',
  '--- FILE: components/Generated.tsx ---',
  'export default function Generated() { return null }',
  '--- END FILE ---',
  '//CODE_END',
].join('\n');
const completeMock = vi.fn(async () => VALID_CODE);
vi.mock('../../src/services/llm/LLMService.js', () => ({
  LLMService: { createProvider: () => ({ complete: completeMock }) },
}));

import { DashboardUpdateService } from '../../src/services/project/DashboardUpdateService.js';
import { RunStateService } from '../../src/services/project/RunStateService.js';
import { TemplateService as RealTemplateService } from '../../src/services/template/TemplateService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `openboard-${prefix}-`));
}

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
    ...overrides,
  };
}

function fakeRegistry(initial: BoardConfig[], sharedDir?: string) {
  let list = [...initial];
  return {
    listBoards: () => list,
    getSharedProjectDir: () => sharedDir,
    removeBoard: vi.fn((id: string) => {
      list = list.filter((b) => b.id !== id);
      return list;
    }),
    upsertBoard: vi.fn((b: BoardConfig) => {
      const i = list.findIndex((x) => x.id === b.id);
      if (i >= 0) list[i] = b;
      else list.push(b);
      return list;
    }),
    current: () => list,
  };
}

function fakeHistory() {
  return { append: vi.fn(), read: () => [], ensure: vi.fn(), delete: vi.fn() };
}

function fakeProjectManager() {
  return {
    getProjectInfo: vi.fn(() => ({ hasNodeModules: true, hasPackageJson: true })),
    install: vi.fn(async () => ({ success: true })),
    build: vi.fn(async () => ({ success: true })),
    commitAndPush: vi.fn(async () => ({ success: true, pushed: true, commitHash: 'abc1234', repoUrl: 'https://github.com/x/y' })),
    // No url -> buildPushDeploy skips network verification.
    deploy: vi.fn(async () => ({ success: true })),
    tagDeploy: vi.fn(async () => ({ success: true, tag: 'deploy-1' })),
  };
}

function fakeTemplate() {
  return {
    restoreAppShell: vi.fn(async () => {}),
    writeProtectedDashboardData: vi.fn(async () => 'api/_data/dash.json'),
    writeGeneratedFile: vi.fn(async () => {}),
    deleteGeneratedFile: vi.fn(async () => {}),
    deleteProtectedDashboardData: vi.fn(async () => {}),
  };
}

function makeService(opts: {
  registry: ReturnType<typeof fakeRegistry>;
  history?: ReturnType<typeof fakeHistory>;
  projectManager?: ReturnType<typeof fakeProjectManager>;
  template?: ReturnType<typeof fakeTemplate>;
  runsDir: string;
}) {
  const history = opts.history ?? fakeHistory();
  const projectManager = opts.projectManager ?? fakeProjectManager();
  const template = opts.template ?? fakeTemplate();
  const service = new DashboardUpdateService(
    opts.registry as unknown as BoardRegistryService,
    history as unknown as PromptHistoryService,
    projectManager as unknown as ProjectManager,
    template as unknown as TemplateService,
    undefined,
    new RunStateService(opts.runsDir),
  );
  return { service, history, projectManager, template };
}

describe('Bulk dashboard operations', () => {
  let runsDir: string;
  let workspace: string;
  const configDir = makeTempDir('cfg');

  beforeEach(() => {
    // Reset implementation too, so a per-test mockResolvedValue can't leak.
    completeMock.mockReset();
    completeMock.mockResolvedValue(VALID_CODE);
    runsDir = makeTempDir('runs');
    workspace = makeTempDir('ws');
    // A configured LLM provider so the internal createLLMConfig() does not throw;
    // the provider itself is mocked, so the key is never used.
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'phase9-test-secret';
    // createLLMConfig() requires a provider; the provider itself is mocked.
    const cfg = new ConfigService();
    cfg.set('llm.provider', 'openai');
    cfg.set('llm.model', 'gpt-4o');
  });

  afterEach(() => {
    for (const dir of [runsDir, workspace]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
    }
  });

  // ── updateAllWithPrompt ────────────────────────────────────────────────────

  describe('updateAllWithPrompt', () => {
    it('fails validation when no dashboards are registered', async () => {
      const { service } = makeService({ registry: fakeRegistry([]), runsDir });
      const result = await service.updateAllWithPrompt('add a footer');
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('E_VALIDATION');
    });

    it('fails when there is no shared workspace', async () => {
      const boards = [makeBoard({ dataFiles: ['x.csv'] })];
      const { service } = makeService({ registry: fakeRegistry(boards, undefined), runsDir });
      const result = await service.updateAllWithPrompt('add a footer');
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('E_UNKNOWN');
    });

    it('generates per board but builds & deploys the shared workspace exactly once', async () => {
      const csv = join(workspace, 'data.csv');
      writeFileSync(csv, 'date,amount\n2026-01-01,10\n2026-01-02,20\n', 'utf-8');
      const boards = [
        makeBoard({ name: 'a', title: 'A', dataFiles: [csv] }),
        makeBoard({ name: 'b', title: 'B', dataFiles: [csv] }),
      ];
      const registry = fakeRegistry(boards, workspace);
      const { service, projectManager, history } = makeService({ registry, runsDir });

      const result = await service.updateAllWithPrompt('add a refresh footer');

      expect(result.success).toBe(true);
      // One LLM generation per board...
      expect(completeMock).toHaveBeenCalledTimes(2);
      // ...but build/push/deploy happen exactly once for the shared app.
      expect(projectManager.build).toHaveBeenCalledTimes(1);
      expect(projectManager.commitAndPush).toHaveBeenCalledTimes(1);
      expect(projectManager.deploy).toHaveBeenCalledTimes(1);
      // History recorded for each board.
      expect(history.append).toHaveBeenCalledTimes(2);
    });

    it('isolates a per-board generation failure and still deploys the rest', async () => {
      const csv = join(workspace, 'data.csv');
      writeFileSync(csv, 'date,amount\n2026-01-01,10\n', 'utf-8');
      // First board's generation returns no code block -> throws, is caught.
      completeMock.mockResolvedValueOnce('sorry, no files this time');
      const boards = [
        makeBoard({ name: 'a', title: 'A', dataFiles: [csv] }),
        makeBoard({ name: 'b', title: 'B', dataFiles: [csv] }),
      ];
      const registry = fakeRegistry(boards, workspace);
      const { service, projectManager } = makeService({ registry, runsDir });

      const result = await service.updateAllWithPrompt('add a footer');

      expect(result.success).toBe(true);          // second board succeeded
      expect(completeMock).toHaveBeenCalledTimes(2); // both attempted
      expect(projectManager.deploy).toHaveBeenCalledTimes(1); // still one deploy
    });

    it('fails only when every board fails', async () => {
      const csv = join(workspace, 'data.csv');
      writeFileSync(csv, 'date,amount\n2026-01-01,10\n', 'utf-8');
      completeMock.mockResolvedValueOnce('no files at all');
      const boards = [makeBoard({ name: 'a', title: 'A', dataFiles: [csv] })];
      const registry = fakeRegistry(boards, workspace);
      const { service, projectManager } = makeService({ registry, runsDir });

      const result = await service.updateAllWithPrompt('add a footer');

      expect(result.success).toBe(false);
      expect(projectManager.deploy).not.toHaveBeenCalled();
    });

    it('skips dashboards with no linked data source', async () => {
      const csv = join(workspace, 'data.csv');
      writeFileSync(csv, 'date,amount\n2026-01-01,10\n', 'utf-8');
      const boards = [
        makeBoard({ name: 'a', title: 'A', dataFiles: [csv] }),
        makeBoard({ name: 'b', title: 'B', dataFiles: [] }), // no data → skipped
      ];
      const registry = fakeRegistry(boards, workspace);
      const { service, projectManager } = makeService({ registry, runsDir });

      const result = await service.updateAllWithPrompt('add a footer');

      expect(result.success).toBe(true);
      expect(completeMock).toHaveBeenCalledTimes(1); // only the board with data
      expect(projectManager.deploy).toHaveBeenCalledTimes(1);
    });
  });

  // ── removeAllDashboards ─────────────────────────────────────────────────────

  describe('removeAllDashboards', () => {
    it('fails validation when no dashboards are registered', async () => {
      const { service } = makeService({ registry: fakeRegistry([]), runsDir });
      const result = await service.removeAllDashboards();
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('E_VALIDATION');
    });

    it('clears the registry without deploying when there is no workspace', async () => {
      const boards = [makeBoard({ name: 'a' }), makeBoard({ name: 'b' })];
      const registry = fakeRegistry(boards, undefined);
      const { service, projectManager } = makeService({ registry, runsDir });

      const result = await service.removeAllDashboards();

      expect(result.success).toBe(true);
      expect(registry.removeBoard).toHaveBeenCalledTimes(2);
      expect(registry.current()).toHaveLength(0);
      expect(projectManager.deploy).not.toHaveBeenCalled();
    });

    it('resets the shell, deletes components + data, clears registry, deploys once', async () => {
      const boards = [
        makeBoard({ name: 'a', title: 'A', components: ['components/A.tsx'] }),
        makeBoard({ name: 'b', title: 'B', components: ['components/B.tsx'] }),
      ];
      const registry = fakeRegistry(boards, workspace);
      const { service, projectManager, template } = makeService({ registry, runsDir });

      const result = await service.removeAllDashboards();

      expect(result.success).toBe(true);
      expect(template.restoreAppShell).toHaveBeenCalledTimes(1);
      expect(template.deleteGeneratedFile).toHaveBeenCalledWith(workspace, 'components/A.tsx');
      expect(template.deleteGeneratedFile).toHaveBeenCalledWith(workspace, 'components/B.tsx');
      expect(template.deleteProtectedDashboardData).toHaveBeenCalledTimes(2);
      expect(registry.current()).toHaveLength(0);
      expect(projectManager.build).toHaveBeenCalledTimes(1);
      expect(projectManager.deploy).toHaveBeenCalledTimes(1);
    });

    it('never deletes the shared shell components', async () => {
      const boards = [makeBoard({ name: 'a', components: ['components/AuthProvider.tsx', 'components/ThemeToggle.tsx', 'components/Real.tsx'] })];
      const registry = fakeRegistry(boards, workspace);
      const { service, template } = makeService({ registry, runsDir });

      await service.removeAllDashboards();

      const deleted = template.deleteGeneratedFile.mock.calls.map((c) => c[1]);
      expect(deleted).toContain('components/Real.tsx');
      expect(deleted).not.toContain('components/AuthProvider.tsx');
      expect(deleted).not.toContain('components/ThemeToggle.tsx');
    });
  });

  // ── TemplateService.restoreAppShell ─────────────────────────────────────────

  describe('TemplateService.restoreAppShell', () => {
    it('overwrites App.tsx with the blank OpenBoard shell', async () => {
      const ts = new RealTemplateService();
      const srcDir = join(workspace, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'App.tsx'), '// a fully custom multi-tab app', 'utf-8');

      await ts.restoreAppShell(workspace);

      const restored = readFileSync(join(srcDir, 'App.tsx'), 'utf-8');
      expect(restored).toContain('OpenBoard');
      expect(restored).toContain('BrandLogo');
      expect(restored).toContain('AuthProvider');
      expect(restored).not.toContain('a fully custom multi-tab app');
      expect(existsSync(join(srcDir, 'App.tsx'))).toBe(true);
    });
  });
});
