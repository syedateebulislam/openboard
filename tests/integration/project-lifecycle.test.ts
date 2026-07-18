/**
 * Integration — full per-board project lifecycle with real npm installs.
 *
 * Runs only via `npm run test:integration` (vitest.integration.config.ts);
 * the default unit run excludes tests/integration. One project is scaffolded
 * and installed once (beforeAll) and reused by every step so the expensive
 * cold `npm install` happens a single time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectManager } from '../../src/services/project/ProjectManager.js';
import { PreviewService } from '../../src/services/deploy/PreviewService.js';
import type { BoardConfig } from '../../src/types/board.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openboard-int-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  // On windows-latest runners TEMP is an 8.3 short path (C:\Users\RUNNER~1\...).
  // Vite resolves index.html to the long form, and the short/long mismatch
  // makes it emit a relative-path asset name that Rollup rejects. Canonicalize.
  return realpathSync.native(dir);
}

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: `board-${Date.now()}`,
    name: 'full-lifecycle',
    title: 'Full Lifecycle Dashboard',
    type: 'finance',
    outputDir: '',
    dataFiles: [],
    components: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ProjectManager full lifecycle (integration)', () => {
  let projectsRoot: string;
  let pm: ProjectManager;
  let projectDir: string;

  beforeAll(async () => {
    projectsRoot = makeTempDir();
    pm = new ProjectManager(projectsRoot);
    delete process.env.OPENBOARD_CONFIG_DIR;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'lifecycle-integration-secret';

    const scaffoldResult = await pm.scaffold(makeBoard());
    expect(scaffoldResult.success, `scaffold failed: ${scaffoldResult.error}`).toBe(true);
    projectDir = scaffoldResult.projectDir!;

    const installResult = await pm.install(projectDir);
    expect(installResult.success, `install failed: ${installResult.error}`).toBe(true);
  }, 660_000); // cold-cache npm install on CI runners can take minutes

  afterAll(async () => {
    PreviewService.stopAll();
    // Small delay for Windows to release file locks
    await new Promise(r => setTimeout(r, 500));
    try {
      rmSync(projectsRoot, { recursive: true, force: true });
    } catch {
      // Windows may still hold locks; ignore cleanup errors in tests
    }
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
  });

  it('installs npm dependencies into the scaffolded project', () => {
    expect(existsSync(join(projectDir, 'node_modules'))).toBe(true);
  });

  it('builds the project with vite', async () => {
    const buildResult = await pm.build(projectDir);
    expect(buildResult.success, `build failed: ${buildResult.error}`).toBe(true);
    expect(existsSync(join(projectDir, 'dist'))).toBe(true);
  }, 300_000);

  it('git-inits and commits the project', async () => {
    const gitInitResult = await pm.gitInit(projectDir);
    expect(gitInitResult.success).toBe(true);

    const commitResult = await pm.gitCommit(projectDir, 'Initial commit');
    expect(commitResult.success, `commit failed: ${commitResult.error}`).toBe(true);
    expect(commitResult.commitHash).toBeTruthy();
  }, 60_000);

  // Real dev-server startup is environment-bound (port binding, spawn timing)
  // and flaky on shared CI runners; keep this as a local-only smoke test.
  it.skipIf(process.env.CI)('starts and stops a local dev server', async () => {
    const previewResult = await pm.preview(projectDir);
    expect(previewResult.success, `preview failed: ${previewResult.error}`).toBe(true);
    expect(previewResult.url).toMatch(/^http:\/\/localhost:\d+/);
    expect(pm.isPreviewRunning(projectDir)).toBe(true);

    pm.stopPreview(projectDir);
    expect(pm.isPreviewRunning(projectDir)).toBe(false);
  }, 120_000);

  it('reports all lifecycle stages in project info', () => {
    const info = pm.getProjectInfo(projectDir);
    expect(info!.hasPackageJson).toBe(true);
    expect(info!.hasNodeModules).toBe(true);
    expect(info!.hasDist).toBe(true);
    expect(info!.hasGit).toBe(true);
  });
});
