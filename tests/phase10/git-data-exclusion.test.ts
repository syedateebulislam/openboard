/**
 * Phase 10 — Raw dashboard data must stay out of Git history (finding #2).
 *
 * Parsed rows live in api/_data/*.json and api/_data/protected-data.ts. They
 * must be deployed to Vercel (CLI uploads the working directory) but never
 * committed/pushed to GitHub. Exclusion uses .git/info/exclude — not
 * .gitignore — so the Vercel CLI's ignore handling never sees it and still
 * uploads the data files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectManager } from '../../src/services/project/ProjectManager.js';
import { crossSpawn } from '../../src/utils/crossSpawn.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openboard-gitexcl-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  const result = await crossSpawn('git', args, { cwd, timeoutMs: 15_000 });
  return { stdout: result.stdout, code: result.code };
}

function writeProjectFiles(dir: string): void {
  mkdirSync(join(dir, 'api', '_data'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.tsx'), 'export {}\n', 'utf-8');
  writeFileSync(join(dir, 'api', '_data', 'orders.json'), '[{"secret":"row"}]\n', 'utf-8');
  writeFileSync(join(dir, 'api', '_data', 'dashboard-data.json'), '{"orders":[{"secret":"row"}]}\n', 'utf-8');
  writeFileSync(
    join(dir, 'api', '_data', 'protected-data.ts'),
    'export const PROTECTED_DASHBOARD_DATA = { orders: [{ secret: "row" }] } as const;\n',
    'utf-8',
  );
}

async function configureTestAuthor(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
}

describe('protected dashboard data git exclusion', () => {
  let projectsRoot: string;
  let dir: string;
  let pm: ProjectManager;

  beforeEach(() => {
    projectsRoot = makeTempDir();
    dir = makeTempDir();
    pm = new ProjectManager(projectsRoot);
  });

  afterEach(() => {
    try { rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* locks */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locks */ }
  });

  it('gitInit writes api/_data exclusions to .git/info/exclude', async () => {
    const result = await pm.gitInit(dir);
    expect(result.success).toBe(true);

    const excludePath = join(dir, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);
    const exclude = readFileSync(excludePath, 'utf-8');
    expect(exclude).toContain('api/_data/*.json');
    expect(exclude).toContain('api/_data/protected-data.ts');
  });

  it('gitCommit never stages raw dashboard data files', async () => {
    writeProjectFiles(dir);
    const init = await pm.gitInit(dir);
    expect(init.success).toBe(true);
    await configureTestAuthor(dir);

    const commit = await pm.gitCommit(dir, 'initial commit');
    expect(commit.success).toBe(true);

    const tracked = await git(dir, ['ls-files']);
    expect(tracked.stdout).toContain('src/main.tsx');
    expect(tracked.stdout).not.toContain('api/_data/orders.json');
    expect(tracked.stdout).not.toContain('api/_data/dashboard-data.json');
    expect(tracked.stdout).not.toContain('api/_data/protected-data.ts');
  });

  it('data files stay in the working tree for Vercel CLI uploads', async () => {
    writeProjectFiles(dir);
    await pm.gitInit(dir);
    await configureTestAuthor(dir);
    await pm.gitCommit(dir, 'initial commit');

    expect(existsSync(join(dir, 'api', '_data', 'orders.json'))).toBe(true);
    expect(existsSync(join(dir, 'api', '_data', 'protected-data.ts'))).toBe(true);
  });

  it('untracks data files that a legacy repo already committed', async () => {
    writeProjectFiles(dir);
    // Legacy repo: data was committed before the exclusion existed.
    await git(dir, ['init']);
    await configureTestAuthor(dir);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'legacy commit with data']);
    expect((await git(dir, ['ls-files'])).stdout).toContain('api/_data/orders.json');

    writeFileSync(join(dir, 'src', 'extra.ts'), 'export {}\n', 'utf-8');
    const commit = await pm.gitCommit(dir, 'update');
    expect(commit.success).toBe(true);

    const tracked = await git(dir, ['ls-files']);
    expect(tracked.stdout).toContain('src/main.tsx');
    expect(tracked.stdout).not.toContain('api/_data/orders.json');
    expect(tracked.stdout).not.toContain('api/_data/protected-data.ts');
    // Working tree copies survive the untracking.
    expect(existsSync(join(dir, 'api', '_data', 'orders.json'))).toBe(true);
  });
});
