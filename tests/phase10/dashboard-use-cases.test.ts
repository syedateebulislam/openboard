import { describe, expect, it, vi } from 'vitest';
import type { BoardConfig } from '../../src/types/board.js';
import { RefreshAllDashboardsUseCase } from '../../src/services/project/useCases/RefreshAllDashboardsUseCase.js';
import { DashboardBuildPipeline } from '../../src/services/project/DashboardBuildPipeline.js';
import { PipelineReporter } from '../../src/services/project/pipelinePhases.js';

function board(name: string): BoardConfig {
  return {
    id: `board-${name}`, name, title: name.toUpperCase(), type: 'custom', outputDir: 'workspace',
    dataFiles: ['data.csv'], components: [], createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('dashboard application use cases', () => {
  it('refreshes every board under one lock and finalizes once', async () => {
    const boards = [board('one'), board('two')];
    const release = vi.fn();
    const refresh = vi.fn(async (item: BoardConfig) => ({
      success: true, board: item, writtenFiles: [`components/${item.name}.tsx`],
    }));
    const finalize = vi.fn(async (item: BoardConfig, files: string[]) => ({
      success: true, board: item, writtenFiles: files, deployUrl: 'https://example.test',
    }));

    const result = await new RefreshAllDashboardsUseCase({
      listBoards: () => boards,
      projectDir: () => 'workspace',
      acquireLock: () => ({ success: true, release }),
      refresh,
      syncComposition: async () => ['components/MasterDashboard.tsx'],
      finalize,
      reconcile: (generated) => generated,
      failure: (item, error, errorCode) => ({ success: false, board: item, error, errorCode }),
    }).execute();

    expect(result).toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0]?.[1]).toEqual([
      'components/one.tsx', 'components/two.tsx', 'components/MasterDashboard.tsx',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stops before build when dependency installation fails', async () => {
    const build = vi.fn();
    const logs: string[] = [];
    const pipeline = new DashboardBuildPipeline({
      boards: () => [board('one')],
      syncManifest: async () => ({ missingBoards: [] }),
      syncShell: async () => ['src/App.tsx'],
      hasDependencies: () => false,
      install: async () => ({ success: false, error: 'registry unavailable' }),
      build,
      repair: async () => ({ success: false }),
    });

    const result = await pipeline.execute('workspace', ['components/one.tsx'], new PipelineReporter((line) => logs.push(line)));
    expect(result).toEqual({ success: false, error: 'Install failed: registry unavailable' });
    expect(build).not.toHaveBeenCalled();
    expect(logs).toContain('Installing dependencies...');
  });

  it('runs the repair stage after a failed generated-code build', async () => {
    const repair = vi.fn(async () => ({ success: true }));
    const pipeline = new DashboardBuildPipeline({
      boards: () => [board('one')],
      syncManifest: async () => ({ missingBoards: [] }),
      syncShell: async () => [],
      hasDependencies: () => true,
      install: async () => ({ success: true }),
      build: async () => ({ success: false, error: 'TS2322' }),
      repair,
    });

    const result = await pipeline.execute('workspace', ['components/one.tsx'], new PipelineReporter());
    expect(result.success).toBe(true);
    expect(repair).toHaveBeenCalledWith('workspace', ['components/one.tsx'], 'TS2322');
  });
});

