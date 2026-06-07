import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeDashboardFromGeneratedApp } from '../../src/screens/ManageBoardsScreen.js';
import type { BoardConfig } from '../../src/types/board.js';

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: 'board-1',
    name: 'sales',
    title: 'Sales',
    type: 'finance',
    outputDir: '',
    dataFiles: [],
    components: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ManageBoardsScreen cleanup helpers', () => {
  let tempDir: string;
  let configDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openboard-manage-test-'));
    configDir = await mkdtemp(join(tmpdir(), 'openboard-manage-config-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'manage-board-test-secret';
  });

  afterEach(async () => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should skip generated UI cleanup when no App.tsx exists', async () => {
    await expect(
      removeDashboardFromGeneratedApp(makeBoard(), [], tempDir),
    ).resolves.toContain('Skipped UI cleanup');
  });

  it('should fail cleanup when App.tsx exists but no LLM provider is configured', async () => {
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(
      join(tempDir, 'src', 'App.tsx'),
      'export default function App() { return <main>Sales</main>; }',
      'utf-8',
    );

    await expect(
      removeDashboardFromGeneratedApp(makeBoard(), [], tempDir),
    ).rejects.toThrow(/No LLM provider is configured/);
  });
});
