/**
 * TemplateService — Scaffold dashboard projects from the base template.
 *
 * Copies all files from `templates/dashboard/` to the output directory,
 * replaces template variables ({{BOARD_NAME}}, {{BOARD_TITLE}}),
 * and writes LLM-generated files into the correct src/ subdirectory.
 */

import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve templates directory relative to this file's location.
// In dev (tsx): this file is at src/services/template/TemplateService.ts → 3 levels up
// In prod (tsup bundle): everything is in dist/index.js → 1 level up
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = __dirname.includes('dist')
  ? resolve(__dirname, '..')
  : resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = resolve(PROJECT_ROOT, 'templates', 'dashboard');

// Binary file extensions — copy without text processing
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz',
]);

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
// App.css and index.css are deliberately NOT allowlisted: they are shell-owned
// and re-synced from the template on every deploy (see SHELL_SYNC_FILES).
// LLM-generated styles belong in components/*.css (e.g. components/generated.css).
const GENERATED_FILE_ALLOWLIST = [
  /^App\.tsx$/,
  /^generated\/[\w.-]+(?:\/[\w.-]+)*\.(?:tsx|ts)$/,
  /^components\/[\w.-]+(?:\/[\w.-]+)*\.(?:tsx|ts|css)$/,
  /^types\/[\w.-]+(?:\/[\w.-]+)*\.ts$/,
  /^hooks\/[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx)$/,
  /^utils\/[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx)$/,
  /^lib\/[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx)$/,
];

// Shell-owned files re-copied from the template into every project before each
// deploy, so template fixes reach existing projects. LLM-owned files are
// deliberately absent: generated components/hooks, api/_data/**,
// package.json (dependency drift must be an explicit migration), index.html.
const SHELL_SYNC_FILES = [
  'src/App.tsx',
  'src/App.css',
  'src/index.css',
  'src/main.tsx',
  'src/components/AuthProvider.tsx',
  'src/components/BrandLogo.tsx',
  'src/components/DashboardHeader.tsx',
  'src/components/DashboardTabs.tsx',
  'src/components/ErrorBoundary.tsx',
  'src/components/HeaderLinks.tsx',
  'src/components/InsightCard.tsx',
  'src/components/LoginPage.tsx',
  'src/components/ThemeToggle.tsx',
  'src/hooks/useAllDashboardsData.ts',
  'src/hooks/useProtectedDashboardData.ts',
  'src/hooks/useTheme.ts',
  // How the master tab reads every other tab's rows. Shell-owned because a
  // generated parser is frozen at the schemas that existed when the master tab
  // was last built, and the master tab is only rebuilt when the dashboard set
  // changes — so a biller that later ships an unseen date format silently
  // vanishes from the overview while its own tab keeps showing it.
  'src/utils/masterOverview.ts',
  'api/_auth.ts',
  'api/_freshness.ts',
  'api/auth.ts',
  'api/dashboard-data.ts',
  'vercel.json',
  'eslint.config.js',
  'tailwind.config.js',
  'vite.config.ts',
  'vite.local-api.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
];

export interface ScaffoldVars {
  boardName: string;
  boardTitle: string;
}

/**
 * Whether an LLM-returned path (relative to src/) is shell-owned.
 *
 * Writing one is never useful: the build pipeline re-syncs shell files from the
 * template moments later, so the generated version is overwritten before it is
 * ever compiled. Rejecting it up front keeps the run log honest about what the
 * model actually contributed.
 */
export function isShellOwnedGeneratedPath(relativePath: string): boolean {
  const normalized = `src/${relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '')}`;
  return SHELL_SYNC_FILES.includes(normalized);
}

export class TemplateService {
  private templatesDir: string;

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir ?? TEMPLATES_DIR;
  }

  /**
   * Scaffold a new dashboard project by copying templates/dashboard/ to outputDir.
   * Replaces {{BOARD_NAME}} and {{BOARD_TITLE}} in all text files.
   *
   * @param outputDir - Absolute path to the output directory (created if needed)
   * @param vars - Template variables: boardName and boardTitle
   */
  async scaffold(outputDir: string, vars: ScaffoldVars): Promise<void> {
    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Copy all files recursively
    await this.copyDirectory(this.templatesDir, outputDir, vars);
  }

  /**
   * Write an LLM-generated file into the src/ subdirectory of the project.
   *
   * @param outputDir - Project root (where package.json lives)
   * @param relativePath - Path relative to src/ (e.g., "components/Overview.tsx")
   * @param content - File content to write
   */
  async writeGeneratedFile(outputDir: string, relativePath: string, content: string): Promise<void> {
    const targetPath = this.resolveGeneratedFilePath(outputDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf-8');
  }

  /**
   * Re-copy shell-owned files from the template into an existing project so
   * template improvements (header, CSS, api handlers, shell components) reach
   * already-generated projects. Never touches LLM-owned files (src/App.tsx,
   * generated components, api/_data). Missing template files are skipped.
   *
   * @returns the project-relative paths that were synced
   */
  async syncShellFiles(outputDir: string, vars?: ScaffoldVars): Promise<string[]> {
    const effectiveVars = vars ?? { boardName: 'openboard-workspace', boardTitle: 'OpenBoardCLI' };
    // Files are independent — copy them concurrently.
    const results = await Promise.all(SHELL_SYNC_FILES.map(async (relPath) => {
      const srcPath = resolve(this.templatesDir, relPath);
      try {
        await stat(srcPath);
      } catch {
        return undefined; // template file absent — skip
      }
      await this.copyFile(srcPath, resolve(outputDir, relPath), effectiveVars);
      return relPath;
    }));
    return results.filter((path): path is string => path !== undefined);
  }

  /**
   * Refresh only the product-owned normalizer used by the master Overview.
   *
   * Master synchronization can short-circuit before the build pipeline when
   * its component hash is current. Keeping this small migration separate from
   * syncShellFiles avoids rewriting the rest of the app shell merely to repair
   * how the Overview reads child-dashboard rows.
   */
  async syncMasterOverviewUtility(outputDir: string): Promise<boolean> {
    const relPath = 'src/utils/masterOverview.ts';
    const srcPath = resolve(this.templatesDir, relPath);
    try {
      await stat(srcPath);
    } catch {
      return false;
    }
    await this.copyFile(srcPath, resolve(outputDir, relPath), {
      boardName: 'openboard-workspace',
      boardTitle: 'OpenBoardCLI',
    });
    return true;
  }

  /**
   * Reset src/App.tsx to the blank OpenBoardCLI shell from the template. Used by
   * "remove all dashboards" to deterministically clear every tab while keeping
   * the auth shell, brand logo, and theme toggle. The template App.tsx has no
   * {{TEMPLATE}} variables, so a direct copy is safe.
   */
  async restoreAppShell(outputDir: string): Promise<void> {
    const source = resolve(this.templatesDir, 'src', 'App.tsx');
    const content = await readFile(source, 'utf-8');
    await this.writeGeneratedFile(outputDir, 'App.tsx', content);
  }

  /**
   * Write parsed dashboard data for server-only API access.
   * This intentionally writes under api/_data, never src/, so raw rows are not
   * bundled into frontend JavaScript.
   */
  async writeProtectedDashboardData(
    outputDir: string,
    dashboardName: string,
    payload: unknown,
  ): Promise<string> {
    const slug = this.sanitizeDashboardDataName(dashboardName);
    const dataRoot = resolve(outputDir, 'api', '_data');
    const targetPath = resolve(dataRoot, `${slug}.json`);
    const containment = relative(dataRoot, targetPath);
    if (containment.startsWith('..') || isAbsolute(containment)) {
      throw new Error(`Unsafe dashboard data name: ${dashboardName}`);
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    await this.writeProtectedDashboardDataModule(dataRoot, slug, payload);
    return `api/_data/${slug}.json`;
  }

  /**
   * Delete protected dashboard data for a removed dashboard.
   * Removes api/_data/<slug>.json, drops <slug> from the aggregate
   * dashboard-data.json, and regenerates protected-data.ts. No-op if absent.
   */
  async deleteProtectedDashboardData(outputDir: string, dashboardName: string): Promise<void> {
    let slug: string;
    try {
      slug = this.sanitizeDashboardDataName(dashboardName);
    } catch {
      return; // unsafe name — nothing we own to delete
    }

    const dataRoot = resolve(outputDir, 'api', '_data');
    await rm(resolve(dataRoot, `${slug}.json`), { force: true });

    const aggregateJsonPath = resolve(dataRoot, 'dashboard-data.json');
    let aggregate: Record<string, unknown> = {};
    try {
      aggregate = JSON.parse(await readFile(aggregateJsonPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return; // no aggregate to update
    }
    if (!(slug in aggregate)) return;

    delete aggregate[slug];
    await this.persistProtectedAggregate(dataRoot, aggregate);
  }

  /**
   * Delete an LLM-generated file under src/. Uses the same containment +
   * allowlist checks as writeGeneratedFile so removal can never escape src/.
   * No-op if the file does not exist.
   */
  async deleteGeneratedFile(outputDir: string, relativePath: string): Promise<void> {
    const targetPath = this.resolveGeneratedFilePath(outputDir, relativePath);
    await rm(targetPath, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveGeneratedFilePath(outputDir: string, relativePath: string): string {
    const normalized = relativePath.trim().replace(/\\/g, '/');
    if (
      normalized.length === 0 ||
      normalized.includes('\0') ||
      relativePath.includes('\\') ||
      isAbsolute(normalized) ||
      WINDOWS_DRIVE_PATH.test(relativePath)
    ) {
      throw new Error(`Unsafe generated file path: ${relativePath}`);
    }

    const srcRoot = resolve(outputDir, 'src');
    const targetPath = resolve(srcRoot, normalized);
    const containment = relative(srcRoot, targetPath);
    if (containment === '' || containment.startsWith('..') || isAbsolute(containment)) {
      throw new Error(`Unsafe generated file path: ${relativePath}`);
    }

    if (!GENERATED_FILE_ALLOWLIST.some((pattern) => pattern.test(normalized))) {
      throw new Error(`Generated file path is not allowed: ${relativePath}`);
    }

    return targetPath;
  }

  private sanitizeDashboardDataName(input: string): string {
    if (
      input.includes('..') ||
      input.includes('/') ||
      input.includes('\\') ||
      input.includes('\0') ||
      WINDOWS_DRIVE_PATH.test(input)
    ) {
      throw new Error(`Unsafe dashboard data name: ${input}`);
    }

    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!slug) {
      throw new Error(`Unsafe dashboard data name: ${input}`);
    }
    return slug;
  }

  private async writeProtectedDashboardDataModule(
    dataRoot: string,
    slug: string,
    payload: unknown,
  ): Promise<void> {
    const aggregateJsonPath = resolve(dataRoot, 'dashboard-data.json');
    let aggregate: Record<string, unknown> = {};
    try {
      aggregate = JSON.parse(await readFile(aggregateJsonPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      aggregate = {};
    }
    aggregate[slug] = payload;

    await this.persistProtectedAggregate(dataRoot, aggregate);
  }

  /**
   * Persist the protected dashboard aggregate to dashboard-data.json and
   * regenerate the typed protected-data.ts module.
   */
  private async persistProtectedAggregate(
    dataRoot: string,
    aggregate: Record<string, unknown>,
  ): Promise<void> {
    // Serialised once and reused. This runs per dashboard and the aggregate
    // holds every dashboard's rows, so writing one board re-encoded all of
    // them — previously twice here, pretty-printed both times, on top of the
    // per-dashboard file. Refreshing N dashboards made that N times over.
    //
    // The .json copy stays indented because a person may open it. The copy
    // embedded in protected-data.ts does not: nothing reads that file by eye,
    // it is compiled, and the indentation was roughly a third of its bytes.
    const indented = JSON.stringify(aggregate, null, 2);

    // Independent paths — no reason to await them in series.
    await Promise.all([
      writeFile(resolve(dataRoot, 'dashboard-data.json'), indented + '\n', 'utf-8'),
      writeFile(
        resolve(dataRoot, 'protected-data.ts'),
        [
          `export const PROTECTED_DASHBOARD_DATA = ${JSON.stringify(aggregate)} as const;`,
          '',
          'export type ProtectedDashboardName = keyof typeof PROTECTED_DASHBOARD_DATA;',
          '',
        ].join('\n'),
        'utf-8',
      ),
    ]);
  }

  private async copyDirectory(srcDir: string, destDir: string, vars: ScaffoldVars): Promise<void> {
    await mkdir(destDir, { recursive: true });

    const entries = await readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath, vars);
      } else if (entry.isFile()) {
        await this.copyFile(srcPath, destPath, vars);
      }
    }
  }

  private async copyFile(srcPath: string, destPath: string, vars: ScaffoldVars): Promise<void> {
    // Ensure parent directory exists
    await mkdir(dirname(destPath), { recursive: true });

    const ext = srcPath.substring(srcPath.lastIndexOf('.')).toLowerCase();

    if (BINARY_EXTENSIONS.has(ext)) {
      // Binary file — copy as-is without text replacement
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    } else {
      // Text file — read, replace variables, write
      const content = await readFile(srcPath, 'utf-8');
      const replaced = this.replaceVars(content, vars);
      await writeFile(destPath, replaced, 'utf-8');
    }
  }

  /**
   * Sanitize a string to prevent injection attacks in generated files.
   * Escapes HTML entities and removes potentially dangerous characters.
   */
  private sanitize(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/`/g, '&#x60;')
      .replace(/\$/g, '&#36;')  // Prevent template literal injection
      .replace(/\\/g, '\\\\');  // Escape backslashes
  }

  /**
   * Sanitize for use in JavaScript/TypeScript string contexts.
   */
  private sanitizeForJs(input: string): string {
    return input
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  private replaceVars(content: string, vars: ScaffoldVars): string {
    // Use JS-safe sanitization for code files, HTML-safe for HTML files
    const jsVars = {
      boardName: this.sanitizeForJs(vars.boardName),
      boardTitle: this.sanitizeForJs(vars.boardTitle),
    };
    const htmlVars = {
      boardName: this.sanitize(vars.boardName),
      boardTitle: this.sanitize(vars.boardTitle),
    };
    
    return content
      .replace(/\{\{BOARD_NAME\}\}/g, jsVars.boardName)
      .replace(/\{\{BOARD_TITLE\}\}/g, jsVars.boardTitle)
      .replace(/\{\{BOARD_NAME_HTML\}\}/g, htmlVars.boardName)
      .replace(/\{\{BOARD_TITLE_HTML\}\}/g, htmlVars.boardTitle);
  }
}

export default TemplateService;
