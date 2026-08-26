/**
 * Phase 9 — master Overview tab + shell ownership:
 *  - MASTER_DASHBOARD_PROMPT loads from prompts/dashboard/master.md
 *  - template ships useAllDashboardsData + the api __all__ branch + HeaderLinks
 *  - App.css/index.css are shell-owned (LLM writes rejected)
 *  - TemplateService.syncShellFiles re-copies shell files without touching
 *    LLM-owned files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MASTER_DASHBOARD_PROMPT } from '../../src/config/dashboardPrompts.js';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { TemplateService } from '../../src/services/template/TemplateService.js';

const TEMPLATE = join(process.cwd(), 'templates', 'dashboard');

describe('Master Overview tab contract', () => {
  it('loads the master prompt with the cross-app aggregation rules', () => {
    expect(MASTER_DASHBOARD_PROMPT).toContain('useAllDashboardsData');
    expect(MASTER_DASHBOARD_PROMPT).toContain('../hooks/useAllDashboardsData');
    expect(MASTER_DASHBOARD_PROMPT).not.toContain('from `./hooks/useAllDashboardsData`');
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/Overview/);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/evidence-first Top Insights/i);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/2-5 material cross-app findings/i);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/Weekly\/Monthly\/Quarterly/);
  });

  it('requires a truthful cross-app spend visualization on first generation', () => {
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/STACKED `BarChart`/);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/initialize every spend-bearing app to numeric zero/i);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/Never use smoothed Line\/Area curves/i);
    expect(MASTER_DASHBOARD_PROMPT).toContain('type="monotone"');
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/more than one meaningful currency exists, never sum/i);
    expect(MASTER_DASHBOARD_PROMPT).toMatch(/activity-by-app trend or ranking/i);
  });

  it('bumps the master contract so existing workspaces regenerate once', () => {
    const service = readFileSync(join(process.cwd(), 'src', 'services', 'project', 'DashboardUpdateService.ts'), 'utf-8');
    expect(service).toContain('const MASTER_CONTRACT_VERSION = 3');
    expect(service).toMatch(/zero-filled stacked bars/i);
  });

  it('protects product-owned composition and the master component in the system prompt', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER return or edit App.tsx');
    expect(SYSTEM_PROMPT).toContain('generated/dashboardManifest.tsx');
    expect(SYSTEM_PROMPT).toContain('MasterDashboard');
    expect(SYSTEM_PROMPT).toContain('src/hooks/useAllDashboardsData.ts');
    expect(SYSTEM_PROMPT).toContain('src/components/HeaderLinks.tsx');
    expect(SYSTEM_PROMPT).toContain('registers the primary component as a tab automatically');
    expect(SYSTEM_PROMPT).toMatch(/never write src\/App\.css or src\/index\.css/i);
  });

  it('ships the all-dashboards hook and the api __all__ branch in the template', () => {
    const hook = readFileSync(join(TEMPLATE, 'src', 'hooks', 'useAllDashboardsData.ts'), 'utf-8');
    expect(hook).toContain("dashboard=__all__");

    const api = readFileSync(join(TEMPLATE, 'api', 'dashboard-data.ts'), 'utf-8');
    expect(api).toContain("'__all__'");
    expect(api).toContain('requireAuth');
    expect(api).toContain('PROTECTED_DASHBOARD_DATA');
  });

  it('ships HeaderLinks and a clickable brand button in the template shell', () => {
    const links = readFileSync(join(TEMPLATE, 'src', 'components', 'HeaderLinks.tsx'), 'utf-8');
    expect(links).toContain('https://openboard-site.vercel.app/#human');
    expect(links).toContain('https://github.com/syedateebulislam/openboard');
    expect(links).toContain('https://www.npmjs.com/package/openboard-cli');
    expect(links).toMatch(/rel="noreferrer"/);
    expect(links).toMatch(/aria-label/);

    const app = readFileSync(join(TEMPLATE, 'src', 'App.tsx'), 'utf-8');
    expect(app).toContain('<HeaderLinks />');
    expect(app).toMatch(/button[\s\S]*?className="app-brand"/);
    expect(app).toContain("setActiveTab(tabs[0].id)");
  });
});

describe('Shell file ownership + sync', () => {
  let projectDir: string;
  const ts = new TemplateService();

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'openboard-shellsync-'));
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('rejects LLM writes to App.css and index.css', async () => {
    await expect(ts.writeGeneratedFile(projectDir, 'App.css', 'body {}')).rejects.toThrow(/not allowed/);
    await expect(ts.writeGeneratedFile(projectDir, 'index.css', 'body {}')).rejects.toThrow(/not allowed/);
    // components CSS remains the sanctioned home for generated styles
    await expect(ts.writeGeneratedFile(projectDir, 'components/generated.css', '.x {}')).resolves.toBeUndefined();
  });

  it('re-copies the product-owned shell while preserving generated components', async () => {
    // Simulate an existing project with stale product-owned App files and a
    // generated dashboard component.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    mkdirSync(join(projectDir, 'src', 'components'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'App.tsx'), '// custom generated app', 'utf-8');
    writeFileSync(join(projectDir, 'src', 'App.css'), '/* stale */', 'utf-8');
    writeFileSync(join(projectDir, 'src', 'components', 'SalesDashboard.tsx'), '// generated dashboard', 'utf-8');

    const synced = await ts.syncShellFiles(projectDir);

    expect(synced).toContain('src/App.css');
    expect(synced).toContain('src/components/HeaderLinks.tsx');
    expect(synced).toContain('src/hooks/useAllDashboardsData.ts');
    expect(synced).toContain('api/dashboard-data.ts');
    expect(synced).toContain('src/App.tsx');
    expect(synced).not.toContain('package.json');

    // Product shell refreshed from the template; dashboard-owned code untouched.
    expect(readFileSync(join(projectDir, 'src', 'App.css'), 'utf-8')).not.toBe('/* stale */');
    expect(readFileSync(join(projectDir, 'src', 'App.tsx'), 'utf-8')).toContain('dashboardManifest');
    expect(readFileSync(join(projectDir, 'src', 'components', 'SalesDashboard.tsx'), 'utf-8')).toBe('// generated dashboard');
    expect(existsSync(join(projectDir, 'package.json'))).toBe(false);
  });
});
