/**
 * ProjectManager — Orchestrates per-board project lifecycle.
 *
 * In normal app usage, OpenBoard uses one shared deployable/runnable project
 * folder inside `projects/`, then adds each dashboard as a tab in that app.
 * Tests and explicit callers can still pass a projectsRoot to exercise
 * per-board scaffolding behavior.
 *
 * Lifecycle:
 *   scaffold → install → build → preview/stop → gitInit → gitCommit → push → deploy
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { TemplateService } from '../template/TemplateService.js';
import { BuildService } from '../build/BuildService.js';
import type { ProgressCallback } from '../build/BuildService.js';
import { PreviewService } from '../deploy/PreviewService.js';
import { GitHubService } from '../deploy/GitHubService.js';
import { VercelService } from '../deploy/VercelService.js';
import { ConfigService } from '../config/ConfigService.js';
import { crossSpawn } from '../../utils/crossSpawn.js';
import { BoardRegistryService } from './BoardRegistryService.js';
import type { BoardConfig } from '../../types/board.js';

// Resolve project root relative to this file.
// In dev (tsx): this file is at src/services/project/ProjectManager.ts → 3 levels up
// In prod (tsup bundle): everything is in dist/index.js → 1 level up
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = __dirname.includes('dist')
  ? resolve(__dirname, '..')
  : resolve(__dirname, '..', '..', '..');
const DEFAULT_TEMPLATES_DIR = resolve(PROJECT_ROOT, 'templates', 'dashboard');

// ── Result types ─────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  success: boolean;
  error?: string;
  projectDir?: string;
  board: BoardConfig;
}

export interface OperationResult {
  success: boolean;
  error?: string;
}

interface DashboardCredentials {
  username: string;
  passwordHash: string;
  jwtSecret: string;
}

const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

export interface BuildResult extends OperationResult {
  outputDir?: string;
}

export interface PreviewResult extends OperationResult {
  url?: string;
  port?: number;
}

export interface GitResult extends OperationResult {
  commitHash?: string;
  pushed?: boolean;
  repoUrl?: string;
}

export interface ProjectInfo {
  projectDir: string;
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  hasDist: boolean;
  hasGit: boolean;
  hasVercel: boolean;
}

// ── ProjectManager ───────────────────────────────────────────────────────────

export class ProjectManager {
  private projectsRoot: string;
  private templatesDir: string;
  private sharedWorkspace: boolean;

  constructor(projectsRoot?: string, templatesDir?: string) {
    this.sharedWorkspace = projectsRoot === undefined;
    // Default: projects/ inside the OpenBoard root
    if (projectsRoot) {
      this.projectsRoot = projectsRoot;
    } else {
      this.projectsRoot = resolve(PROJECT_ROOT, 'projects');
    }
    this.templatesDir = templatesDir ?? DEFAULT_TEMPLATES_DIR;
  }

  /**
   * Generate a unique project directory path: <projectsRoot>/openboard-<type>-<name>-<uuid8>
   */
  generateProjectDir(boardName: string, boardType = 'dashboard'): string {
    const uuid8 = randomUUID().slice(0, 8);
    const dirName = `openboard-${boardType}-${boardName}-${uuid8}`;
    return join(this.projectsRoot, dirName);
  }

  /**
   * Scaffold a new dashboard project from the template.
   * Creates the project folder and populates it with template files.
   */
  async scaffold(board: BoardConfig): Promise<ScaffoldResult> {
    try {
      const registry = new BoardRegistryService();
      const existingProjectDir = this.sharedWorkspace ? registry.getSharedProjectDir() : undefined;
      const projectDir = existingProjectDir ?? (
        this.sharedWorkspace
          ? this.generateProjectDir('workspace', 'app')
          : this.generateProjectDir(board.name, board.type)
      );

      if (!existingProjectDir) {
        const templateService = new TemplateService(this.templatesDir);

        await templateService.scaffold(projectDir, {
          boardName: this.sharedWorkspace ? 'openboard-workspace' : board.name,
          boardTitle: this.sharedWorkspace ? 'OpenBoard' : board.title,
        });

        if (this.sharedWorkspace) {
          registry.setSharedProjectDir(projectDir);
        }
      }

      // Write .env with dashboard credentials for local preview
      try {
        const { ConfigService } = await import('../config/ConfigService.js');
        const cfg = new ConfigService();
        const username = cfg.get('credentials.username') as string | undefined;
        const passwordHash = cfg.getSecret('credentials.passwordHash');
        const jwtSecret = cfg.getSecret('credentials.jwtSecret');

        if (username && passwordHash && jwtSecret) {
          VercelService.writeEnvFile(projectDir, {
            DASHBOARD_USERNAME: username,
            DASHBOARD_PASSWORD_HASH: passwordHash,
            JWT_SECRET: jwtSecret,
          });
        }
      } catch {
        // Config not available — skip credential injection
      }

      const updatedBoard: BoardConfig = {
        ...board,
        outputDir: projectDir,
      };

      if (this.sharedWorkspace) {
        registry.upsertBoard(updatedBoard);
      }

      return {
        success: true,
        projectDir,
        board: updatedBoard,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
        board,
      };
    }
  }

  /**
   * Install npm dependencies in the project.
   */
  async install(projectDir: string, onProgress?: ProgressCallback): Promise<OperationResult> {
    if (!existsSync(join(projectDir, 'package.json'))) {
      return { success: false, error: 'No package.json found in project directory' };
    }
    return BuildService.install(projectDir, onProgress);
  }

  /**
   * Build the project (TypeScript check + Vite build).
   */
  async build(projectDir: string, onProgress?: ProgressCallback): Promise<BuildResult> {
    if (!existsSync(join(projectDir, 'package.json'))) {
      return { success: false, error: 'No package.json found in project directory' };
    }
    const result = await BuildService.build(projectDir, onProgress);
    return {
      success: result.success,
      error: result.error,
      outputDir: result.outputDir,
    };
  }

  /**
   * Start a local dev server for preview.
   */
  async preview(projectDir: string, port?: number, onProgress?: ProgressCallback): Promise<PreviewResult> {
    if (!existsSync(join(projectDir, 'package.json'))) {
      return { success: false, error: 'No package.json found in project directory' };
    }
    try {
      const result = await PreviewService.start(projectDir, port, onProgress);
      return {
        success: result.success,
        error: result.error,
        url: result.url,
        port: result.port,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Stop the local dev server for a project.
   */
  stopPreview(projectDir: string): boolean {
    return PreviewService.stop(projectDir);
  }

  /**
   * Check if a preview server is running for a project.
   */
  isPreviewRunning(projectDir: string): boolean {
    return PreviewService.isRunning(projectDir);
  }

  /**
   * Initialize a git repository in the project.
   */
  async gitInit(projectDir: string): Promise<GitResult> {
    const result = await GitHubService.initRepo(projectDir);
    if (!result.success) return { success: false, error: result.error };

    return { success: true };
  }

  /**
   * Stage all files and commit.
   * Auto-initializes git if not already a git repo.
   * Uses a direct spawn to handle Windows shell quoting properly.
   */
  async gitCommit(projectDir: string, message: string): Promise<GitResult> {
    // Auto-init git if not already initialized
    if (!existsSync(join(projectDir, '.git'))) {
      const initResult = await this.gitInit(projectDir);
      if (!initResult.success) {
        return { success: false, error: `Git init failed: ${initResult.error}` };
      }
    }

    try {
      // Stage all files
      const addResult = await crossSpawn('git', ['add', '.'], { cwd: projectDir, timeoutMs: 30_000 });
      if (addResult.code !== 0) return { success: false, error: addResult.stderr };

      // Check for changes
      const statusResult = await crossSpawn('git', ['status', '--porcelain'], { cwd: projectDir, timeoutMs: 10_000 });
      if (!statusResult.stdout.trim()) return { success: false, error: 'No changes to commit' };

      const authorResult = await GitHubService.ensureCommitAuthor(projectDir);
      if (!authorResult.success) return { success: false, error: authorResult.error };

      // Commit — useShell: false to avoid Windows arg splitting on special chars
      const commitResult = await crossSpawn('git', ['commit', '-m', message], { cwd: projectDir, timeoutMs: 30_000, useShell: false });
      if (commitResult.code !== 0) return { success: false, error: commitResult.stderr };

      // Get hash
      const hashResult = await crossSpawn('git', ['rev-parse', 'HEAD'], { cwd: projectDir, timeoutMs: 10_000 });
      return { success: true, commitHash: hashResult.stdout.trim() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Push to GitHub (requires remote to be set).
   */
  async gitPush(projectDir: string, branch?: string, onProgress?: ProgressCallback): Promise<GitResult> {
    const result = await GitHubService.push(projectDir, branch, onProgress);
    return {
      success: result.success,
      error: result.error,
      pushed: result.pushed,
    };
  }

  /**
   * Full push: commit + push in one step.
   * Auto-initializes git if not already a git repo.
   */
  async commitAndPush(projectDir: string, message: string, onProgress?: ProgressCallback): Promise<GitResult> {
    // Auto-init git if not already initialized
    if (!existsSync(join(projectDir, '.git'))) {
      onProgress?.('📋 Initializing git repository...');
      const initResult = await this.gitInit(projectDir);
      if (!initResult.success) {
        return { success: false, error: `Git init failed: ${initResult.error}` };
      }
    }

    const result = await GitHubService.commitAndPush(projectDir, message, undefined, onProgress);
    return {
      success: result.success,
      error: result.error,
      commitHash: result.commitHash,
      pushed: result.pushed,
      repoUrl: result.repoUrl,
    };
  }

  /**
   * List deploy tags (deploy-N) in the generated repo, ascending by N.
   */
  async listDeployTags(projectDir: string): Promise<string[]> {
    if (!existsSync(join(projectDir, '.git'))) return [];
    const result = await crossSpawn('git', ['tag', '--list', 'deploy-*'], { cwd: projectDir, timeoutMs: 10_000 });
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => /^deploy-\d+$/.test(tag))
      .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  }

  /**
   * Tag HEAD as the next deploy-N after a successful deploy, so rollback has
   * a stable target. Pushes the tag when a remote exists (best-effort).
   */
  async tagDeploy(projectDir: string, onProgress?: ProgressCallback): Promise<{ success: boolean; tag?: string; error?: string }> {
    try {
      if (!existsSync(join(projectDir, '.git'))) {
        return { success: false, error: 'Not a git repository' };
      }
      const tags = await this.listDeployTags(projectDir);
      const next = tags.length > 0 ? Number(tags[tags.length - 1].slice(7)) + 1 : 1;
      const tag = `deploy-${next}`;
      const tagResult = await crossSpawn('git', ['tag', tag], { cwd: projectDir, timeoutMs: 10_000 });
      if (tagResult.code !== 0) return { success: false, error: tagResult.stderr };

      const remote = await crossSpawn('git', ['remote'], { cwd: projectDir, timeoutMs: 10_000 });
      if (remote.stdout.trim()) {
        await crossSpawn('git', ['push', 'origin', tag], { cwd: projectDir, timeoutMs: 30_000 });
      }
      onProgress?.(`Tagged deployment: ${tag}`);
      return { success: true, tag };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Restore the working tree to the previous deploy tag and commit the
   * rollback. The caller is responsible for rebuild + push + redeploy.
   */
  async restorePreviousDeploy(projectDir: string, onProgress?: ProgressCallback): Promise<{ success: boolean; tag?: string; error?: string }> {
    try {
      const tags = await this.listDeployTags(projectDir);
      if (tags.length < 2) {
        return { success: false, error: 'No previous deploy tag to roll back to (need at least 2 tagged deploys).' };
      }
      const prev = tags[tags.length - 2];

      // read-tree --reset -u restores index AND working tree to the tag,
      // including deleting files added since — an exact snapshot restore.
      const readTree = await crossSpawn('git', ['read-tree', '--reset', '-u', prev], { cwd: projectDir, timeoutMs: 30_000 });
      if (readTree.code !== 0) return { success: false, error: readTree.stderr };

      const author = await GitHubService.ensureCommitAuthor(projectDir);
      if (!author.success) return { success: false, error: author.error };

      const commit = await crossSpawn('git', ['commit', '-m', `rollback: restore ${prev}`], { cwd: projectDir, timeoutMs: 30_000, useShell: false });
      if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return { success: false, error: commit.stderr };
      }
      onProgress?.(`Restored working tree to ${prev}`);
      return { success: true, tag: prev };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Pre-deploy checks — fix common issues in generated projects before deploying.
   * Runs automatically before every Vercel deployment.
   *
   * Checks:
   *  1. Remove `tsc -b` from build script (LLM-generated code has TS errors)
   *  2. Ensure tsconfig has relaxed settings (noUnusedLocals/noUnusedParameters off)
   *  3. Ensure .gitignore has .env (don't commit secrets)
   *  4. Ensure AuthProvider/LoginPage exist and App.tsx still gates through auth
   */
  preDeployChecks(projectDir: string, onProgress?: ProgressCallback): OperationResult {
    onProgress?.('Running pre-deploy checks...');

    // 1. Fix build script — remove tsc -b to avoid TS type errors blocking deploy
    const pkgPath = join(projectDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const buildScript = pkg.scripts?.build || '';
        if (buildScript.includes('tsc')) {
          pkg.scripts.build = 'vite build';
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
          onProgress?.('  Fixed build script: removed tsc (prevents TS errors blocking deploy)');
        }
      } catch {
        onProgress?.('  Could not read/fix package.json');
      }
    }

    // 2. Fix tsconfig — relax strict checks that break LLM-generated code
    const tsconfigAppPath = join(projectDir, 'tsconfig.app.json');
    if (existsSync(tsconfigAppPath)) {
      try {
        const tsconfig = JSON.parse(readFileSync(tsconfigAppPath, 'utf-8'));
        let changed = false;
        if (tsconfig.compilerOptions?.noUnusedLocals === true) {
          tsconfig.compilerOptions.noUnusedLocals = false;
          changed = true;
        }
        if (tsconfig.compilerOptions?.noUnusedParameters === true) {
          tsconfig.compilerOptions.noUnusedParameters = false;
          changed = true;
        }
        if (changed) {
          writeFileSync(tsconfigAppPath, JSON.stringify(tsconfig, null, 2) + '\n', 'utf-8');
          onProgress?.('  Fixed tsconfig: relaxed noUnusedLocals/noUnusedParameters');
        }
      } catch {
        onProgress?.('  Could not read/fix tsconfig.app.json');
      }
    }

    // 3. Ensure .gitignore has .env
    const gitignorePath = join(projectDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = readFileSync(gitignorePath, 'utf-8');
        if (!content.includes('.env')) {
          writeFileSync(gitignorePath, content.trimEnd() + '\n.env\n.env.local\n', 'utf-8');
          onProgress?.('  Added .env to .gitignore');
        }
      } catch {
        // skip
      }
    }

    // 4. Ensure Vercel security headers are present
    this.repairVercelSecurityHeaders(projectDir, onProgress);

    // 4b. Remove duplicate dashboard tabs/imports the LLM may have appended
    //     across (re)generations — agent retries can add the same tab twice.
    this.dedupeAppDashboards(projectDir, onProgress);

    // 4c. Refresh product-owned shell files (design system + brand assets)
    //     from the template so existing workspaces pick up OpenBoard UI
    //     updates without a re-scaffold.
    this.syncProductShellFiles(projectDir, onProgress);

    // 5. Ensure auth/data protection files exist
    const authProviderPath = join(projectDir, 'src', 'components', 'AuthProvider.tsx');
    const loginPagePath = join(projectDir, 'src', 'components', 'LoginPage.tsx');
    const authApiPath = join(projectDir, 'api', 'auth.ts');
    const sharedAuthApiPath = join(projectDir, 'api', '_auth.ts');
    const dashboardDataApiPath = join(projectDir, 'api', 'dashboard-data.ts');
    const protectedDataModulePath = join(projectDir, 'api', '_data', 'protected-data.ts');
    const protectedDataHookPath = join(projectDir, 'src', 'hooks', 'useProtectedDashboardData.ts');
    const appPath = join(projectDir, 'src', 'App.tsx');
    this.repairGeneratedSupportFile(projectDir, 'api/_auth.ts', onProgress);
    this.repairGeneratedSupportFile(projectDir, 'api/dashboard-data.ts', onProgress);
    this.repairGeneratedSupportFile(projectDir, 'api/_data/protected-data.ts', onProgress);
    this.repairGeneratedSupportFile(projectDir, 'src/hooks/useProtectedDashboardData.ts', onProgress);

    const missingAuthFiles = [
      !existsSync(authProviderPath) ? 'src/components/AuthProvider.tsx' : undefined,
      !existsSync(loginPagePath) ? 'src/components/LoginPage.tsx' : undefined,
      !existsSync(authApiPath) ? 'api/auth.ts' : undefined,
      !existsSync(sharedAuthApiPath) ? 'api/_auth.ts' : undefined,
      !existsSync(dashboardDataApiPath) ? 'api/dashboard-data.ts' : undefined,
      !existsSync(protectedDataModulePath) ? 'api/_data/protected-data.ts' : undefined,
      !existsSync(protectedDataHookPath) ? 'src/hooks/useProtectedDashboardData.ts' : undefined,
    ].filter(Boolean);
    if (missingAuthFiles.length > 0) {
      const error = `Generated dashboard auth is incomplete. Missing: ${missingAuthFiles.join(', ')}`;
      onProgress?.(`  ${error}`);
      return { success: false, error };
    }
    if (!this.appUsesAuthGate(appPath)) {
      const error = 'Generated dashboard auth is incomplete. App.tsx must use AuthProvider, useAuth, and LoginPage before deployment.';
      onProgress?.(`  ${error}`);
      return { success: false, error };
    }

    const frontendSecurity = this.checkFrontendSecurity(projectDir);
    if (!frontendSecurity.success) {
      onProgress?.(`  ${frontendSecurity.error}`);
      return frontendSecurity;
    }

    onProgress?.('Pre-deploy checks complete');
    return { success: true };
  }

  /**
   * Deploy to Vercel (production).
   * Auto-injects dashboard credentials from config before deploying.
   */
  async deploy(projectDir: string, onProgress?: ProgressCallback): Promise<OperationResult & { url?: string }> {
    // Step 0: Pre-deploy checks — fix common issues
    const preDeploy = this.preDeployChecks(projectDir, onProgress);
    if (!preDeploy.success) {
      return preDeploy;
    }

    // Step 1: Validate Vercel auth before link/env/deploy so failures are actionable.
    const auth = await VercelService.checkAuthenticated(projectDir, onProgress);
    if (!auth.success) {
      return { success: false, error: auth.error };
    }

    // Step 2: Link to Vercel project first (creates .vercel dir)
    const linked = await VercelService.ensureLinked(projectDir, onProgress);
    if (!linked.success) {
      return { success: false, error: `Vercel link failed: ${linked.error}` };
    }

    // Step 3: Inject dashboard credentials (now .vercel exists, env vars will be set)
    const credentials = this.getDashboardCredentialsForDeploy();
    if (!credentials.success || !credentials.credentials) {
      onProgress?.(credentials.error ?? 'Dashboard credentials are missing.');
      return { success: false, error: credentials.error };
    }
    await VercelService.injectCredentials(projectDir, credentials.credentials, onProgress);

    // Step 4: Deploy
    const result = await VercelService.deployProduction(projectDir, onProgress);
    return {
      success: result.success,
      error: result.error,
      url: result.url,
    };
  }

  validateDashboardCredentials(): OperationResult {
    const result = this.getDashboardCredentialsForDeploy();
    return { success: result.success, error: result.error };
  }

  /**
   * List all project directories under projectsRoot.
   */
  listProjects(): string[] {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  /**
   * Get info about a project (what stages it has completed).
   */
  getProjectInfo(projectDir: string): ProjectInfo | null {
    if (!existsSync(projectDir)) return null;
    return {
      projectDir,
      hasPackageJson: existsSync(join(projectDir, 'package.json')),
      hasNodeModules: existsSync(join(projectDir, 'node_modules')),
      hasDist: existsSync(join(projectDir, 'dist')),
      hasGit: existsSync(join(projectDir, '.git')),
      hasVercel: existsSync(join(projectDir, '.vercel')),
    };
  }

  /**
   * Get the projects root directory path.
   */
  getProjectsRoot(): string {
    return this.projectsRoot;
  }

  private appUsesAuthGate(appPath: string): boolean {
    if (!existsSync(appPath)) return false;
    try {
      const content = readFileSync(appPath, 'utf-8');
      return (
        content.includes('AuthProvider') &&
        content.includes('useAuth') &&
        content.includes('LoginPage') &&
        /<AuthProvider\b/.test(content)
      );
    } catch {
      return false;
    }
  }

  private getDashboardCredentialsForDeploy(): OperationResult & { credentials?: DashboardCredentials } {
    try {
      const cfg = new ConfigService();
      const username = cfg.get('credentials.username') as string | undefined;
      const passwordHash = cfg.getSecret('credentials.passwordHash');
      const jwtSecret = cfg.getSecret('credentials.jwtSecret');

      if (!username || !passwordHash || !jwtSecret) {
        const missing = [
          username ? undefined : 'dashboard username',
          passwordHash ? undefined : 'dashboard password hash',
          jwtSecret ? undefined : 'dashboard JWT secret',
        ].filter(Boolean);
        return {
          success: false,
          error: `Dashboard credentials are missing or cannot be decrypted: ${missing.join(', ')}. Open Settings > Reset dashboard login, save credentials, then run /deploy again.`,
        };
      }

      return {
        success: true,
        credentials: {
          username,
          passwordHash,
          jwtSecret,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Could not read dashboard credentials: ${error.message}. Open Settings > Reset dashboard login, save credentials, then run /deploy again.`,
      };
    }
  }

  /**
   * Product-owned shell files: the OpenBoard design system and brand assets
   * every generated app must share. Refreshed from the template on each
   * pre-deploy pass so existing workspaces pick up UI updates. LLM-owned
   * files (App.tsx, dashboard components) are never touched here. None of
   * these files contain {{TEMPLATE}} variables, so a raw copy is safe.
   */
  private static readonly PRODUCT_SHELL_FILES = [
    'src/App.css',
    'src/index.css',
    'src/components/BrandLogo.tsx',
    'src/components/ThemeToggle.tsx',
    'src/hooks/useTheme.ts',
    'public/favicon.svg',
  ];

  private syncProductShellFiles(projectDir: string, onProgress?: ProgressCallback): void {
    for (const relativePath of ProjectManager.PRODUCT_SHELL_FILES) {
      const sourcePath = join(this.templatesDir, ...relativePath.split('/'));
      if (!existsSync(sourcePath)) continue;
      const targetPath = join(projectDir, ...relativePath.split('/'));
      try {
        const source = readFileSync(sourcePath, 'utf-8');
        const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : null;
        if (current === source) continue;
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, source, 'utf-8');
        onProgress?.(`  Refreshed product shell file: ${relativePath}`);
      } catch {
        // Best-effort — the build step surfaces real problems.
      }
    }
  }

  private repairGeneratedSupportFile(
    projectDir: string,
    relativePath: string,
    onProgress?: ProgressCallback,
  ): void {
    const targetPath = join(projectDir, ...relativePath.split('/'));
    if (existsSync(targetPath)) return;

    const sourcePath = join(this.templatesDir, ...relativePath.split('/'));
    if (!existsSync(sourcePath)) return;

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    onProgress?.(`  Added missing generated support file: ${relativePath}`);
  }

  /**
   * Remove duplicate dashboard tabs and duplicate component imports from
   * src/App.tsx. The agent flow rewrites App.tsx through the LLM on every
   * generation; interrupted/retried runs can make it append a tab (or import)
   * that already exists. This deterministically keeps the first occurrence of
   * each tab id / import and drops later duplicates. Conservative: only writes
   * when braces stay balanced, so it never corrupts hand- or LLM-authored code.
   */
  private dedupeAppDashboards(projectDir: string, onProgress?: ProgressCallback): void {
    const appPath = join(projectDir, 'src', 'App.tsx');
    if (!existsSync(appPath)) return;

    let content: string;
    try {
      content = readFileSync(appPath, 'utf-8');
    } catch {
      return;
    }
    const original = content;

    // 1. Drop exact-duplicate component import lines (keep the first).
    const seenImports = new Set<string>();
    content = content
      .split('\n')
      .filter((line) => {
        if (/^\s*import\s+\{[^}]+\}\s+from\s+['"]\.\/components\/[\w.-]+['"];?\s*$/.test(line)) {
          const key = line.trim();
          if (seenImports.has(key)) return false;
          seenImports.add(key);
        }
        return true;
      })
      .join('\n');

    // 2. Drop duplicate tab objects by id. Match brace blocks that contain a
    //    quoted `id: '...'` and no nested braces (generated tabs render
    //    `component: <X />`), so the interface and JSX `id={...}` are untouched.
    const seenIds = new Set<string>();
    let removed = 0;
    content = content.replace(
      /\{[^{}]*?\bid:\s*['"]([\w-]+)['"][^{}]*?\}\s*,?/g,
      (block, id: string) => {
        if (seenIds.has(id)) {
          removed += 1;
          return '';
        }
        seenIds.add(id);
        return block;
      },
    );

    if (content === original) return;

    // Safety: only write if braces remain balanced.
    const opens = (content.match(/\{/g) || []).length;
    const closes = (content.match(/\}/g) || []).length;
    if (opens !== closes) {
      onProgress?.('  Skipped App.tsx tab dedupe (unsafe to edit automatically)');
      return;
    }

    // Collapse blank-line runs left by removed blocks.
    content = content.replace(/\n{3,}/g, '\n\n');
    writeFileSync(appPath, content, 'utf-8');
    if (removed > 0) {
      onProgress?.(`  Removed ${removed} duplicate dashboard tab(s) from App.tsx`);
    } else {
      onProgress?.('  Removed duplicate dashboard import(s) from App.tsx');
    }
  }

  private repairVercelSecurityHeaders(projectDir: string, onProgress?: ProgressCallback): void {
    const vercelConfigPath = join(projectDir, 'vercel.json');
    let config: any = {};
    if (existsSync(vercelConfigPath)) {
      try {
        config = JSON.parse(readFileSync(vercelConfigPath, 'utf-8'));
      } catch {
        config = {};
      }
    }

    const rewrites = Array.isArray(config.rewrites) && config.rewrites.length > 0
      ? config.rewrites
      : [
          { source: '/api/(.*)', destination: '/api/$1' },
          { source: '/(.*)', destination: '/index.html' },
        ];

    const existingHeaders = Array.isArray(config.headers) ? config.headers : [];
    const globalHeader = existingHeaders.find((entry: any) => entry?.source === '/(.*)') ?? {
      source: '/(.*)',
      headers: [],
    };
    const headerMap = new Map<string, string>();
    for (const header of Array.isArray(globalHeader.headers) ? globalHeader.headers : []) {
      if (typeof header?.key === 'string' && typeof header?.value === 'string') {
        headerMap.set(header.key.toLowerCase(), header.value);
      }
    }

    let changed = false;
    for (const header of SECURITY_HEADERS) {
      if (headerMap.get(header.key.toLowerCase()) !== header.value) {
        headerMap.set(header.key.toLowerCase(), header.value);
        changed = true;
      }
    }

    const nextHeaders = SECURITY_HEADERS.map(header => ({ ...header }));
    for (const [key, value] of headerMap.entries()) {
      if (!SECURITY_HEADERS.some(header => header.key.toLowerCase() === key)) {
        nextHeaders.push({ key, value });
      }
    }

    const nextConfig = {
      ...config,
      headers: [
        { source: '/(.*)', headers: nextHeaders },
        ...existingHeaders.filter((entry: any) => entry?.source !== '/(.*)'),
      ],
      rewrites,
    };

    if (changed || !existsSync(vercelConfigPath)) {
      writeFileSync(vercelConfigPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf-8');
      onProgress?.('  Added Vercel security headers');
    }
  }

  private checkFrontendSecurity(projectDir: string): OperationResult {
    const srcDir = join(projectDir, 'src');
    if (!existsSync(srcDir)) return { success: true };

    const files = this.listFrontendSourceFiles(srcDir);
    for (const file of files) {
      let content = '';
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const relative = file.slice(projectDir.length + 1).replace(/\\/g, '/');
      const violations = [
        /\bDASHBOARD_(?:USERNAME|PASSWORD_HASH)\b/.test(content) ? 'dashboard credential env name' : undefined,
        /\bJWT_SECRET\b/.test(content) ? 'JWT secret env name' : undefined,
        /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/.test(content) ? 'bcrypt hash literal' : undefined,
        /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(content) ? 'JWT literal' : undefined,
        /window\.location\.hostname[\s\S]{0,500}setUser\s*\(/.test(content) ? 'hostname-gated client auth bypass' : undefined,
        /setUser\s*\([\s\S]{0,500}window\.location\.hostname/.test(content) ? 'hostname-gated client auth bypass' : undefined,
        /setUser\s*\(\s*\{\s*username\s*:\s*['"]dev['"]/.test(content) ? 'client-side dev auth bypass' : undefined,
        /dangerouslySetInnerHTML/.test(content) ? 'dangerouslySetInnerHTML usage' : undefined,
      ].filter(Boolean);

      if (violations.length > 0) {
        return {
          success: false,
          error: `Frontend security check failed in ${relative}: ${violations.join(', ')}. Remove client-side auth bypasses and hardcoded secrets before deploy.`,
        };
      }
    }

    return { success: true };
  }

  private listFrontendSourceFiles(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        result.push(...this.listFrontendSourceFiles(fullPath));
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        result.push(fullPath);
      }
    }
    return result;
  }
}

export default ProjectManager;
