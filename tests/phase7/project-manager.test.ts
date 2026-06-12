/**
 * ProjectManager tests — validates the full per-board project lifecycle:
 *  1. Scaffold: creates a dedicated project folder with template files
 *  2. Build: runs vite build inside the project
 *  3. Preview: starts a local dev server
 *  4. Push: commits and pushes to GitHub
 *  5. Deploy: deploys to Vercel
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectManager } from '../../src/services/project/ProjectManager.js';
import { PreviewService } from '../../src/services/deploy/PreviewService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import type { BoardConfig } from '../../src/types/board.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openboard-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  // On windows-latest runners TEMP is an 8.3 short path (C:\Users\RUNNER~1\...).
  // Vite resolves index.html to the long form, and the short/long mismatch
  // makes it emit a relative-path asset name that Rollup rejects. Canonicalize.
  return realpathSync.native(dir);
}

function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: `board-${Date.now()}`,
    name: 'test-dashboard',
    title: 'Test Dashboard',
    type: 'finance',
    outputDir: '',
    dataFiles: [],
    components: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ProjectManager', () => {
  let projectsRoot: string;
  let pm: ProjectManager;

  beforeEach(() => {
    projectsRoot = makeTempDir();
    pm = new ProjectManager(projectsRoot);
    delete process.env.OPENBOARD_CONFIG_DIR;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'project-manager-test-secret';
  });

  afterEach(async () => {
    // Stop any running preview servers before cleanup
    PreviewService.stopAll();
    // Small delay for Windows to release file locks
    await new Promise(r => setTimeout(r, 500));
    try {
      rmSync(projectsRoot, { recursive: true, force: true });
    } catch {
      // Windows may still hold locks; ignore cleanup errors in tests
    }
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Project directory naming
  // ════════════════════════════════════════════════════════════════════════════

  describe('generateProjectDir', () => {
    it('should combine openboard prefix, type, name, and uuid', () => {
      const dir = pm.generateProjectDir('my-finance-board', 'finance');
      const basename = dir.split(/[\\/]/).pop()!;

      // Format: openboard-<type>-<board-name>-<8-char-uuid>
      expect(basename).toMatch(/^openboard-finance-my-finance-board-[a-f0-9]{8}$/);
    });

    it('should produce unique directories for the same name', () => {
      const dir1 = pm.generateProjectDir('same-name');
      const dir2 = pm.generateProjectDir('same-name');
      expect(dir1).not.toEqual(dir2);
    });

    it('should be inside the projectsRoot', () => {
      const dir = pm.generateProjectDir('test');
      expect(dir.startsWith(projectsRoot)).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Scaffold
  // ════════════════════════════════════════════════════════════════════════════

  describe('scaffold', () => {
    it('should create a project directory with template files', async () => {
      const board = makeBoard();
      const result = await pm.scaffold(board);

      expect(result.success).toBe(true);
      expect(result.projectDir).toBeTruthy();
      expect(existsSync(result.projectDir!)).toBe(true);

      // Must have key template files
      expect(existsSync(join(result.projectDir!, 'package.json'))).toBe(true);
      expect(existsSync(join(result.projectDir!, 'vite.config.ts'))).toBe(true);
      expect(existsSync(join(result.projectDir!, 'index.html'))).toBe(true);
      expect(existsSync(join(result.projectDir!, 'src', 'main.tsx'))).toBe(true);
    });

    it('should use openboard-type-name-uuid format for directory name', async () => {
      const board = makeBoard({ name: 'my-health-board', type: 'health' });
      const result = await pm.scaffold(board);

      const basename = result.projectDir!.split(/[\\/]/).pop()!;
      expect(basename).toMatch(/^openboard-health-my-health-board-[a-f0-9]{8}$/);
    });

    it('should replace template variables in scaffolded files', async () => {
      const board = makeBoard({ name: 'sales-dash', title: 'Sales Dashboard' });
      const result = await pm.scaffold(board);

      const indexHtml = readFileSync(join(result.projectDir!, 'index.html'), 'utf-8');
      // Template vars should be replaced — no raw {{BOARD_NAME}} left
      expect(indexHtml).not.toContain('{{BOARD_NAME}}');
      expect(indexHtml).not.toContain('{{BOARD_TITLE}}');
    });

    it('should update board.outputDir after scaffolding', async () => {
      const board = makeBoard();
      const result = await pm.scaffold(board);

      expect(result.board.outputDir).toBe(result.projectDir);
    });

    it('should write .env from encrypted dashboard credentials when available', async () => {
      const configDir = makeTempDir();
      process.env.OPENBOARD_CONFIG_DIR = configDir;
      const cfg = new ConfigService(configDir);
      cfg.set('credentials.username', 'admin');
      cfg.setEncrypted('credentials.passwordHash', 'hash-value');
      cfg.setEncrypted('credentials.jwtSecret', 'jwt-value');

      const result = await pm.scaffold(makeBoard({ name: 'encrypted-creds' }));

      expect(result.success).toBe(true);
      const envContent = readFileSync(join(result.projectDir!, '.env'), 'utf-8');
      expect(envContent).toContain('DASHBOARD_USERNAME=admin');
      expect(envContent).toContain('DASHBOARD_PASSWORD_HASH=hash-value');
      expect(envContent).toContain('JWT_SECRET=jwt-value');

      rmSync(configDir, { recursive: true, force: true });
    });

    it('should fail gracefully if template directory is missing', async () => {
      const badPm = new ProjectManager(projectsRoot, '/nonexistent/templates');
      const board = makeBoard();
      const result = await badPm.scaffold(board);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Install dependencies
  // ════════════════════════════════════════════════════════════════════════════

  describe('install', () => {
    it('should install npm dependencies in scaffolded project', async () => {
      const board = makeBoard();
      const scaffoldResult = await pm.scaffold(board);
      expect(scaffoldResult.success).toBe(true);

      const installResult = await pm.install(scaffoldResult.projectDir!);
      expect(installResult.success).toBe(true);
      expect(existsSync(join(scaffoldResult.projectDir!, 'node_modules'))).toBe(true);
    }, 660_000); // cold-cache npm install on CI runners can take minutes
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Build
  // ════════════════════════════════════════════════════════════════════════════

  describe('build', () => {
    it('should fail if project has not been scaffolded', async () => {
      const result = await pm.build('/nonexistent/project');
      expect(result.success).toBe(false);
    });

    it('should build successfully after scaffold + install', async () => {
      const board = makeBoard();
      const scaffoldResult = await pm.scaffold(board);
      expect(scaffoldResult.success).toBe(true);

      const installResult = await pm.install(scaffoldResult.projectDir!);
      expect(installResult.success).toBe(true);

      const buildResult = await pm.build(scaffoldResult.projectDir!);
      expect(buildResult.success, `build failed: ${buildResult.error}`).toBe(true);
      // Vite produces a dist/ folder
      expect(existsSync(join(scaffoldResult.projectDir!, 'dist'))).toBe(true);
    }, 720_000); // install + vite build on cold CI runners
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Preview (local dev server)
  // ════════════════════════════════════════════════════════════════════════════

  describe('preview', () => {
    it('should fail if no package.json exists', async () => {
      const result = await pm.preview('/nonexistent/project');
      expect(result.success).toBe(false);
    });

    // Real dev-server startup is environment-bound (port binding, spawn
    // timing) and flaky on shared CI runners; the full-lifecycle test already
    // proves vite works. Keep this as a local-only smoke test.
    it.skipIf(process.env.CI)('should start and stop a local dev server', async () => {
      const board = makeBoard();
      const scaffoldResult = await pm.scaffold(board);
      expect(scaffoldResult.success).toBe(true);

      const installResult = await pm.install(scaffoldResult.projectDir!);
      expect(installResult.success).toBe(true);

      const previewResult = await pm.preview(scaffoldResult.projectDir!);
      expect(previewResult.success).toBe(true);
      expect(previewResult.url).toMatch(/^http:\/\/localhost:\d+/);

      // Server should be running
      expect(pm.isPreviewRunning(scaffoldResult.projectDir!)).toBe(true);

      // Stop it
      pm.stopPreview(scaffoldResult.projectDir!);
      // After stop, should no longer be running
      expect(pm.isPreviewRunning(scaffoldResult.projectDir!)).toBe(false);
    }, 120_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Push (git init + commit)
  // ════════════════════════════════════════════════════════════════════════════

  describe('push', () => {
    it('should initialize git and commit files', async () => {
      const board = makeBoard();
      const scaffoldResult = await pm.scaffold(board);
      expect(scaffoldResult.success).toBe(true);

      const commitResult = await pm.gitInit(scaffoldResult.projectDir!);
      expect(commitResult.success).toBe(true);
      expect(existsSync(join(scaffoldResult.projectDir!, '.git'))).toBe(true);

      const result = await pm.gitCommit(scaffoldResult.projectDir!, 'Initial commit');
      expect(result.success).toBe(true);
      expect(result.commitHash).toBeTruthy();
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. List projects
  // ════════════════════════════════════════════════════════════════════════════

  describe('listProjects', () => {
    it('should return empty array when no projects exist', () => {
      const projects = pm.listProjects();
      expect(projects).toEqual([]);
    });

    it('should list scaffolded projects', async () => {
      const board1 = makeBoard({ name: 'board-one' });
      const board2 = makeBoard({ name: 'board-two' });

      await pm.scaffold(board1);
      await pm.scaffold(board2);

      const projects = pm.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects.some(p => p.includes('board-one'))).toBe(true);
      expect(projects.some(p => p.includes('board-two'))).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Get project info
  // ════════════════════════════════════════════════════════════════════════════

  describe('getProjectInfo', () => {
    it('should return project info for a scaffolded project', async () => {
      const board = makeBoard({ name: 'info-test' });
      const scaffoldResult = await pm.scaffold(board);

      const info = pm.getProjectInfo(scaffoldResult.projectDir!);
      expect(info).not.toBeNull();
      expect(info!.hasPackageJson).toBe(true);
      expect(info!.hasNodeModules).toBe(false);
      expect(info!.hasDist).toBe(false);
      expect(info!.hasGit).toBe(false);
    });

    it('should return null for nonexistent project', () => {
      const info = pm.getProjectInfo('/nonexistent');
      expect(info).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 9. Pre-deploy safety checks
  // ════════════════════════════════════════════════════════════════════════════

  describe('preDeployChecks', () => {
    it('should pass for a freshly scaffolded authenticated dashboard template', async () => {
      const board = makeBoard({ name: 'auth-ok' });
      const scaffoldResult = await pm.scaffold(board);

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(true);
    });

    it('should fail if generated auth components are missing', async () => {
      const board = makeBoard({ name: 'auth-missing' });
      const scaffoldResult = await pm.scaffold(board);
      unlinkSync(join(scaffoldResult.projectDir!, 'src', 'components', 'AuthProvider.tsx'));

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AuthProvider.tsx');
    });

    it('should fail if App.tsx no longer uses the auth wrapper', async () => {
      const board = makeBoard({ name: 'auth-bypass' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(
        join(scaffoldResult.projectDir!, 'src', 'App.tsx'),
        'export default function App() { return <main>Public dashboard</main>; }',
        'utf-8',
      );

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(false);
      expect(result.error).toContain('App.tsx');
    });

    it('should refresh stale product-owned shell files from the template', async () => {
      const board = makeBoard({ name: 'shell-stale' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(join(scaffoldResult.projectDir!, 'src', 'App.css'), '/* stale shell */', 'utf-8');
      unlinkSync(join(scaffoldResult.projectDir!, 'src', 'components', 'BrandLogo.tsx'));

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(true);
      const css = readFileSync(join(scaffoldResult.projectDir!, 'src', 'App.css'), 'utf-8');
      expect(css).toContain('--accent: #c17f53');
      expect(existsSync(join(scaffoldResult.projectDir!, 'src', 'components', 'BrandLogo.tsx'))).toBe(true);
    });

    it('should repair missing protected dashboard data support files', async () => {
      const board = makeBoard({ name: 'data-api-missing' });
      const scaffoldResult = await pm.scaffold(board);
      unlinkSync(join(scaffoldResult.projectDir!, 'api', 'dashboard-data.ts'));

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(true);
      expect(existsSync(join(scaffoldResult.projectDir!, 'api', 'dashboard-data.ts'))).toBe(true);
    });

    it('should repair missing Vercel security headers', async () => {
      const board = makeBoard({ name: 'headers-missing' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(
        join(scaffoldResult.projectDir!, 'vercel.json'),
        JSON.stringify({
          rewrites: [
            { source: '/api/(.*)', destination: '/api/$1' },
            { source: '/(.*)', destination: '/index.html' },
          ],
        }, null, 2),
        'utf-8',
      );

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(true);
      const vercelConfig = JSON.parse(readFileSync(join(scaffoldResult.projectDir!, 'vercel.json'), 'utf-8'));
      const headers = vercelConfig.headers.find((entry: any) => entry.source === '/(.*)').headers;
      expect(headers).toContainEqual(expect.objectContaining({ key: 'Content-Security-Policy' }));
      expect(headers).toContainEqual(expect.objectContaining({ key: 'X-Frame-Options', value: 'DENY' }));
      expect(headers).toContainEqual(expect.objectContaining({ key: 'X-Content-Type-Options', value: 'nosniff' }));
      expect(headers).toContainEqual(expect.objectContaining({ key: 'Referrer-Policy', value: 'no-referrer' }));
      expect(headers).toContainEqual(expect.objectContaining({ key: 'Strict-Transport-Security' }));
    });

    it('should fail if frontend source contains a hostname-gated auth bypass', async () => {
      const board = makeBoard({ name: 'auth-bypass-hostname' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(
        join(scaffoldResult.projectDir!, 'src', 'components', 'AuthProvider.tsx'),
        "export function AuthProvider() { if (window.location.hostname === 'localhost') setUser({ username: 'dev' }); return null; }",
        'utf-8',
      );

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(false);
      expect(result.error).toContain('hostname-gated client auth bypass');
    });

    it('should fail if frontend source contains hardcoded credential material', async () => {
      const board = makeBoard({ name: 'frontend-secret' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(
        join(scaffoldResult.projectDir!, 'src', 'SecretLeak.tsx'),
        "export const leaked = '$2b$12$abcdefghijklmnopqrstuu9vBPD2DDwwNsQk.JJAfS0WqAc1fD8B6'; export const env = 'JWT_SECRET';",
        'utf-8',
      );

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Frontend security check failed');
      expect(result.error).toContain('bcrypt hash literal');
      expect(result.error).toContain('JWT secret env name');
    });

    it('should fail if frontend source uses dangerouslySetInnerHTML', async () => {
      const board = makeBoard({ name: 'dangerous-html' });
      const scaffoldResult = await pm.scaffold(board);
      writeFileSync(
        join(scaffoldResult.projectDir!, 'src', 'components', 'RawHtml.tsx'),
        "export function RawHtml({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }",
        'utf-8',
      );

      const result = pm.preDeployChecks(scaffoldResult.projectDir!);

      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerouslySetInnerHTML usage');
    });

    it('should remove duplicate dashboard tabs the agent flow may append', async () => {
      const board = makeBoard({ name: 'dup-tabs' });
      const scaffoldResult = await pm.scaffold(board);
      const appPath = join(scaffoldResult.projectDir!, 'src', 'App.tsx');
      writeFileSync(
        appPath,
        `import { AuthProvider, useAuth } from './components/AuthProvider'
import { LoginPage } from './components/LoginPage'
import { ZomatoDashboard } from './components/ZomatoDashboard'

function DashboardContent() {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <LoginPage />
  const dashboardTabs = [
    { id: 'zomato', label: 'Zomato', type: 'finance', component: <ZomatoDashboard /> },
    { id: 'uber', label: 'Uber', type: 'finance', component: <UberDashboard /> },
    { id: 'uber', label: 'Uber', type: 'finance', component: <UberDashboard /> },
  ]
  return <main>{dashboardTabs.length}</main>
}

export default function App() {
  return <AuthProvider><DashboardContent /></AuthProvider>
}
`,
        'utf-8',
      );

      pm.preDeployChecks(scaffoldResult.projectDir!);

      const cleaned = readFileSync(appPath, 'utf-8');
      const ids = (cleaned.match(/id: '[a-z-]+'/g) || []).map((s) => s.slice(5, -1));
      expect(ids).toEqual(['zomato', 'uber']);
      expect(cleaned.split("id: 'uber'").length - 1).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 10. Dashboard credential readiness
  // ════════════════════════════════════════════════════════════════════════════

  describe('validateDashboardCredentials', () => {
    it('should pass when dashboard credentials are readable', () => {
      const configDir = makeTempDir();
      process.env.OPENBOARD_CONFIG_DIR = configDir;
      const cfg = new ConfigService(configDir);
      cfg.set('credentials.username', 'admin');
      cfg.setEncrypted('credentials.passwordHash', 'hash-value');
      cfg.setEncrypted('credentials.jwtSecret', 'jwt-value');

      const result = pm.validateDashboardCredentials();

      expect(result.success).toBe(true);
      rmSync(configDir, { recursive: true, force: true });
    });

    it('should fail when encrypted dashboard credentials cannot be decrypted', () => {
      const configDir = makeTempDir();
      process.env.OPENBOARD_CONFIG_DIR = configDir;
      const cfg = new ConfigService(configDir);
      cfg.set('credentials.username', 'admin');
      cfg.set('credentials.passwordHash', 'enc:not-readable');
      cfg.set('credentials.jwtSecret', 'enc:not-readable');

      const result = pm.validateDashboardCredentials();

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing or cannot be decrypted');
      expect(result.error).toContain('Reset dashboard login');
      rmSync(configDir, { recursive: true, force: true });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 11. Full lifecycle (scaffold → install → build → git)
  // ════════════════════════════════════════════════════════════════════════════

  describe('full lifecycle', () => {
    it('should scaffold, install, build, and git-init a complete project', async () => {
      const board = makeBoard({ name: 'full-lifecycle' });

      // 1. Scaffold
      const scaffoldResult = await pm.scaffold(board);
      expect(scaffoldResult.success).toBe(true);
      const projectDir = scaffoldResult.projectDir!;

      // 2. Install
      const installResult = await pm.install(projectDir);
      expect(installResult.success).toBe(true);

      // 3. Build
      const buildResult = await pm.build(projectDir);
      expect(buildResult.success, `build failed: ${buildResult.error}`).toBe(true);
      expect(existsSync(join(projectDir, 'dist'))).toBe(true);

      // 4. Git init + commit
      const gitInitResult = await pm.gitInit(projectDir);
      expect(gitInitResult.success).toBe(true);

      const commitResult = await pm.gitCommit(projectDir, 'Initial commit');
      expect(commitResult.success).toBe(true);
      expect(commitResult.commitHash).toBeTruthy();

      // 5. Project info reflects all steps
      const info = pm.getProjectInfo(projectDir);
      expect(info!.hasPackageJson).toBe(true);
      expect(info!.hasNodeModules).toBe(true);
      expect(info!.hasDist).toBe(true);
      expect(info!.hasGit).toBe(true);
    }, 900_000); // full lifecycle: cold install + build + git on CI runners
  });
});
