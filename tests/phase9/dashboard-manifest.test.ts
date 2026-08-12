import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardManifestService } from '../../src/services/project/DashboardManifestService.js';
import type { BoardConfig } from '../../src/types/board.js';

function board(name: string, title: string, component: string): BoardConfig {
  return {
    id: `board-${name}`,
    name,
    title,
    type: 'finance',
    outputDir: '',
    dataFiles: [],
    components: [component, 'App.tsx'],
    createdAt: new Date().toISOString(),
  };
}

describe('DashboardManifestService', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('deterministically composes tabs and component imports without LLM-owned App.tsx', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'openboard-manifest-'));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'src', 'components'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'components', 'SalesDashboard.tsx'), [
      "import { useProtectedDashboardData } from '../hooks/useProtectedDashboardData';",
      "export function SalesDashboard() { useProtectedDashboardData('sales'); return <div>Sales</div>; }",
    ].join('\n'));
    writeFileSync(join(projectDir, 'src', 'components', 'Costs.tsx'), 'export default function Costs() { return <div>Costs</div>; }');
    writeFileSync(join(projectDir, 'src', 'components', 'MasterDashboard.tsx'), 'export function MasterDashboard() { return <div>Master</div>; }');

    const result = await new DashboardManifestService().sync(projectDir, [
      board('sales', 'Sales', 'components/SalesDashboard.tsx'),
      board('costs', 'Costs', 'components/Costs.tsx'),
    ]);
    const manifest = readFileSync(join(projectDir, 'src', result.path), 'utf-8');

    expect(result.missingBoards).toEqual([]);
    // Each dashboard is loaded lazily so only the open tab's chart code is
    // fetched; a static import put every dashboard in the initial bundle.
    expect(manifest).toContain("import { lazy } from 'react'");
    expect(manifest).toContain("lazy(() => import('../components/MasterDashboard')");
    expect(manifest).toContain("lazy(() => import(\"../components/SalesDashboard\")");
    // Named and default exports both have to resolve to a default for lazy().
    expect(manifest).toContain('m.SalesDashboard');
    expect(manifest).toContain('m.default');
    expect(manifest).toContain("{ id: \"sales\", label: \"Sales\", group: \"Finance\" }");
    expect(manifest).toContain("case \"costs\": return <DashboardComponent1 />");
    expect(manifest).not.toContain('App.tsx');
  });

  it('keeps a tab with a repair message when a legacy component is missing', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'openboard-manifest-missing-'));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const result = await new DashboardManifestService().sync(projectDir, [
      board('legacy', 'Legacy', 'components/Missing.tsx'),
    ]);
    const manifest = readFileSync(join(projectDir, 'src', result.path), 'utf-8');

    expect(result.missingBoards).toEqual(['Legacy']);
    expect(manifest).toContain('Regenerate this dashboard');
    expect(manifest).toContain('id: "legacy"');
  });
});
