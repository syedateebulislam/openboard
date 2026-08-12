/**
 * Deterministic dashboard composition.
 *
 * LLMs own individual dashboard components. OpenBoardCLI owns the application
 * shell, tab order, imports, and component routing through this generated
 * manifest. This prevents one model response from dropping unrelated tabs.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BoardConfig } from '../../types/board.js';
import { TemplateService } from '../template/TemplateService.js';

export interface DashboardManifestResult {
  path: 'generated/dashboardManifest.tsx';
  missingBoards: string[];
}

interface ComponentTarget {
  path: string;
  exportName: string;
  isDefault: boolean;
}

const SHELL_COMPONENT = /(?:AuthProvider|BrandLogo|DashboardHeader|DashboardTabs|ErrorBoundary|HeaderLinks|InsightCard|LoginPage|MasterDashboard|ThemeToggle)\.tsx$/i;

function dashboardGroup(type: BoardConfig['type']): string {
  const groups: Partial<Record<BoardConfig['type'], string>> = {
    finance: 'Finance',
    invoices: 'Finance',
    grocery: 'Food & Dining',
    food: 'Food & Dining',
    travel: 'Travel',
    shopping: 'Shopping',
    subscriptions: 'Subscriptions',
    health: 'Health',
    utilities: 'Utilities',
  };
  return groups[type] ?? 'Other';
}

function modulePath(componentPath: string): string {
  return `../${componentPath.replace(/\.(?:tsx|ts)$/i, '')}`;
}

function exportedComponent(content: string, componentPath: string): Omit<ComponentTarget, 'path'> | undefined {
  const defaultNamed = content.match(/export\s+default\s+(?:function|class)\s+([A-Za-z_$][\w$]*)/);
  if (defaultNamed) return { exportName: defaultNamed[1], isDefault: true };
  if (/export\s+default\s+(?:function\s*\(|[A-Za-z_$][\w$]*\s*;?)/.test(content)) {
    return { exportName: 'default', isDefault: true };
  }
  const named = [...content.matchAll(/export\s+(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  if (named.length === 0) return undefined;
  const fileStem = basename(componentPath).replace(/\.(?:tsx|ts)$/i, '').toLowerCase();
  return {
    exportName: named.find((name) => name.toLowerCase() === fileStem)
      ?? named.find((name) => /dashboard|page|view/i.test(name))
      ?? named[0],
    isDefault: false,
  };
}

export class DashboardManifestService {
  constructor(private readonly templates = new TemplateService()) {}

  async sync(projectDir: string, boards: BoardConfig[]): Promise<DashboardManifestResult> {
    // One board's component lookup does not depend on another's, and each one
    // reads several candidate files off disk. Resolving them together keeps
    // manifest sync flat in board count instead of linear in it. Promise.all
    // preserves order, which the manifest's tab order relies on.
    const targets: Array<{ board: BoardConfig; target?: ComponentTarget }> = await Promise.all(
      boards.map(async (board) => ({
        board,
        target: await this.findComponent(projectDir, board),
      })),
    );

    const missingBoards = targets.filter((entry) => !entry.target).map((entry) => entry.board.title);
    const imports: string[] = [
      "import { lazy } from 'react';",
      "import type { ComponentType } from 'react';",
      "import type { DashboardTabItem } from '../components/DashboardTabs';",
    ];
    const declarations: string[] = [];
    const tabs: string[] = [];
    const cases: string[] = [];

    const masterPath = join(projectDir, 'src', 'components', 'MasterDashboard.tsx');
    if (boards.length > 0 && existsSync(masterPath)) {
      const content = await readFile(masterPath, 'utf-8').catch(() => '');
      const exported = exportedComponent(content, 'components/MasterDashboard.tsx');
      if (exported) {
        declarations.push(
          `const MasterComponent = lazy(() => import('../components/MasterDashboard')`
            + `.then((m) => ({ default: (m.${exported.isDefault ? 'default' : exported.exportName}) as ComponentType })));`,
        );
        tabs.push(`  { id: 'master', label: 'Overview' },`);
        cases.push(`    case 'master': return <MasterComponent />;`);
      }
    }

    targets.forEach(({ board, target }, index) => {
      const component = `DashboardComponent${index}`;
      if (target) {
        // lazy() rather than a static namespace import: the app renders one
        // tab at a time, but a static import put every dashboard's chart code
        // into the initial bundle, so opening the first tab downloaded all of
        // them. Vite splits each of these into its own chunk.
        declarations.push(
          `const ${component} = lazy(() => import(${JSON.stringify(modulePath(target.path))})`
            + `.then((m) => ({ default: (m.${target.isDefault ? 'default' : target.exportName}) as ComponentType })));`,
        );
        cases.push(`    case ${JSON.stringify(board.name)}: return <${component} />;`);
      } else {
        cases.push(`    case ${JSON.stringify(board.name)}: return <div className="card">Dashboard component is unavailable. Regenerate this dashboard.</div>;`);
      }
      tabs.push(`  { id: ${JSON.stringify(board.name)}, label: ${JSON.stringify(board.title)}, group: ${JSON.stringify(dashboardGroup(board.type))} },`);
    });

    const content = [
      '/* Product-owned file generated by OpenBoardCLI. Do not ask the LLM to edit it. */',
      ...imports,
      '',
      ...declarations,
      '',
      'export const dashboardTabs: DashboardTabItem[] = [',
      ...tabs,
      '];',
      '',
      'export function renderDashboard(id: string) {',
      '  switch (id) {',
      ...cases,
      "    default: return <div className=\"card\">Select a dashboard.</div>;",
      '  }',
      '}',
      '',
    ].join('\n');

    await this.templates.writeGeneratedFile(projectDir, 'generated/dashboardManifest.tsx', content);
    return { path: 'generated/dashboardManifest.tsx', missingBoards };
  }

  private async findComponent(projectDir: string, board: BoardConfig): Promise<ComponentTarget | undefined> {
    const candidates = [...new Set(board.components)]
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => /^components\/.+\.tsx$/i.test(path) && !SHELL_COMPONENT.test(path));

    // Candidates are read together for the same reason boards are: they are
    // independent files and the loop was paying a full round trip each.
    const read = await Promise.all(
      candidates.map(async (path) => {
        const fullPath = join(projectDir, 'src', ...path.split('/'));
        // readFile already reports a missing file; existsSync was a second
        // stat of the same path to learn what the catch below covers anyway.
        const content = await readFile(fullPath, 'utf-8').catch(() => '');
        return { path, content };
      }),
    );

    const scored: Array<ComponentTarget & { score: number }> = [];
    for (const { path, content } of read) {
      if (!content) continue;
      const exported = exportedComponent(content, path);
      if (!exported) continue;
      const lower = basename(path).toLowerCase();
      let score = 0;
      if (content.includes(`useProtectedDashboardData('${board.name}')`) || content.includes(`useProtectedDashboardData("${board.name}")`)) score += 100;
      if (lower.includes(board.name.toLowerCase().replace(/[^a-z0-9]/g, ''))) score += 30;
      if (/dashboard|page|view/.test(lower)) score += 20;
      if (exported.isDefault) score += 5;
      scored.push({ path, ...exported, score });
    }
    return scored.sort((a, b) => b.score - a.score)[0];
  }
}

export default DashboardManifestService;
