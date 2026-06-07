/**
 * PHASE 1: TemplateService Tests
 *
 * Tests project scaffolding, variable replacement, and generated file writing.
 * Uses real template files + temp output directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { TemplateService } from '../../src/services/template/TemplateService.js';

describe('TemplateService', () => {
  let tempDir: string;
  let ts: TemplateService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openboard-tmpl-test-'));
    ts = new TemplateService();
  });

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 300)); // Windows file lock delay
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Project Scaffolding
  // -------------------------------------------------------------------------

  describe('Project Scaffolding', () => {
    it('should create all required static files', async () => {
      await ts.scaffold(tempDir, { boardName: 'test-board', boardTitle: 'Test Board' });

      const requiredFiles = [
        'package.json',
        'vite.config.ts',
        'index.html',
        'api/auth.ts',
        'api/dashboard-data.ts',
        'api/_auth.ts',
        'api/_data/protected-data.ts',
        'src/main.tsx',
        'src/App.tsx',
        'src/App.css',
        'src/index.css',
        'src/components/LoginPage.tsx',
        'src/components/AuthProvider.tsx',
        'src/hooks/useProtectedDashboardData.ts',
        'src/types/auth.ts',
      ];

      for (const file of requiredFiles) {
        expect(existsSync(join(tempDir, file))).toBe(true);
      }
    });

    it('should create required subdirectories', async () => {
      await ts.scaffold(tempDir, { boardName: 'test-board', boardTitle: 'Test Board' });

      const requiredDirs = ['api', 'src', 'src/components', 'src/hooks', 'src/types'];
      for (const dir of requiredDirs) {
        expect(existsSync(join(tempDir, dir))).toBe(true);
      }
    });

    it('should create output directory if it does not exist', async () => {
      const nestedDir = join(tempDir, 'nested', 'project');
      await ts.scaffold(nestedDir, { boardName: 'nested', boardTitle: 'Nested' });
      expect(existsSync(join(nestedDir, 'package.json'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Template Variable Replacement
  // -------------------------------------------------------------------------

  describe('Template Variable Replacement', () => {
    it('should replace {{BOARD_NAME}} in package.json', async () => {
      await ts.scaffold(tempDir, { boardName: 'my-finance-dash', boardTitle: 'Finance Dashboard' });

      const packageJson = await readFile(join(tempDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(packageJson);
      expect(pkg.name).toBe('my-finance-dash');
      expect(packageJson).not.toContain('{{BOARD_NAME}}');
    });

    it('should replace {{BOARD_TITLE}} in index.html', async () => {
      await ts.scaffold(tempDir, { boardName: 'health', boardTitle: 'Health Analytics' });

      const indexHtml = await readFile(join(tempDir, 'index.html'), 'utf-8');
      expect(indexHtml).not.toContain('{{BOARD_TITLE}}');
    });

    it('should have no unreplaced {{PLACEHOLDER}} in any file', async () => {
      await ts.scaffold(tempDir, { boardName: 'sales', boardTitle: 'Sales Dashboard' });

      // Check key text files for leftover placeholders
      const filesToCheck = [
        'package.json',
        'index.html',
        'src/App.tsx',
      ];

      for (const file of filesToCheck) {
        const content = await readFile(join(tempDir, file), 'utf-8');
        expect(content).not.toMatch(/\{\{[A-Z_]+\}\}/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auth Template Files
  // -------------------------------------------------------------------------

  describe('Auth Template Files', () => {
    it('should include LoginPage with form structure', async () => {
      await ts.scaffold(tempDir, { boardName: 'auth-test', boardTitle: 'Auth Test' });

      const loginPage = await readFile(join(tempDir, 'src/components/LoginPage.tsx'), 'utf-8');
      expect(loginPage).toContain('password');
      expect(loginPage).toContain('/api/auth');
    });

    it('should include AuthProvider with useAuth hook', async () => {
      await ts.scaffold(tempDir, { boardName: 'auth-test', boardTitle: 'Auth Test' });

      const authProvider = await readFile(join(tempDir, 'src/components/AuthProvider.tsx'), 'utf-8');
      expect(authProvider).toContain('useAuth');
      expect(authProvider).toContain('AuthProvider');
      expect(authProvider).toContain('createContext');
      expect(authProvider).toContain('isAuthenticated');
    });
  });

  // -------------------------------------------------------------------------
  // Package.json Validation
  // -------------------------------------------------------------------------

  describe('Package.json Validation', () => {
    it('should include required production dependencies', async () => {
      await ts.scaffold(tempDir, { boardName: 'deps-test', boardTitle: 'Deps Test' });

      const packageJson = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf-8'));
      const deps = packageJson.dependencies || {};

      expect(deps).toHaveProperty('react');
      expect(deps).toHaveProperty('react-dom');
      expect(deps).toHaveProperty('recharts');
      expect(deps).toHaveProperty('lucide-react');
      expect(deps).toHaveProperty('date-fns');
    });

    it('should mark package as private', async () => {
      await ts.scaffold(tempDir, { boardName: 'private-test', boardTitle: 'Private' });

      const packageJson = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf-8'));
      expect(packageJson.private).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Write Generated Files
  // -------------------------------------------------------------------------

  describe('Write Generated Files', () => {
    it('should write LLM-generated component to src/components/', async () => {
      await ts.scaffold(tempDir, { boardName: 'gen-test', boardTitle: 'Gen Test' });

      const componentContent = `export function RevenueChart() {
  return <div>Revenue Chart</div>;
}`;

      await ts.writeGeneratedFile(tempDir, 'components/RevenueChart.tsx', componentContent);

      const written = await readFile(join(tempDir, 'src/components/RevenueChart.tsx'), 'utf-8');
      expect(written).toContain('RevenueChart');
    });

    it('should overwrite App.tsx with LLM-generated content', async () => {
      await ts.scaffold(tempDir, { boardName: 'overwrite-test', boardTitle: 'Overwrite' });

      const newAppContent = `export default function App() { return <div>Updated App</div>; }`;
      await ts.writeGeneratedFile(tempDir, 'App.tsx', newAppContent);

      const written = await readFile(join(tempDir, 'src/App.tsx'), 'utf-8');
      expect(written).toContain('Updated App');
    });

    it('should reject generated paths that escape src with parent traversal', async () => {
      await ts.scaffold(tempDir, { boardName: 'escape-test', boardTitle: 'Escape' });
      await writeFile(join(tempDir, 'package.json'), '{"safe":true}', 'utf-8');

      await expect(
        ts.writeGeneratedFile(tempDir, '../package.json', '{"owned":true}'),
      ).rejects.toThrow(/Unsafe generated file path/);

      const packageJson = await readFile(join(tempDir, 'package.json'), 'utf-8');
      expect(packageJson).toBe('{"safe":true}');
    });

    it('should reject absolute and Windows-drive generated paths', async () => {
      await ts.scaffold(tempDir, { boardName: 'absolute-test', boardTitle: 'Absolute' });

      await expect(
        ts.writeGeneratedFile(tempDir, '/tmp/evil.tsx', 'export default null;'),
      ).rejects.toThrow(/Unsafe generated file path/);

      await expect(
        ts.writeGeneratedFile(tempDir, 'C:\\tmp\\evil.tsx', 'export default null;'),
      ).rejects.toThrow(/Unsafe generated file path/);
    });

    it('should reject generated paths outside the dashboard allowlist', async () => {
      await ts.scaffold(tempDir, { boardName: 'allowlist-test', boardTitle: 'Allowlist' });

      await expect(
        ts.writeGeneratedFile(tempDir, 'main.tsx', 'console.log("replace bootstrap")'),
      ).rejects.toThrow(/not allowed/);
      await expect(
        ts.writeGeneratedFile(tempDir, 'data/privateRows.ts', 'export const rows = []'),
      ).rejects.toThrow(/not allowed/);
      await expect(
        ts.writeGeneratedFile(tempDir, 'components/../../App.tsx', 'export default null;'),
      ).rejects.toThrow(/Unsafe generated file path/);
    });
  });

  describe('Protected Dashboard Data', () => {
    it('should write parsed dashboard data outside src for protected API access', async () => {
      await ts.scaffold(tempDir, { boardName: 'data-test', boardTitle: 'Data Test' });

      await ts.writeProtectedDashboardData(tempDir, 'Uber Rides', {
        rows: [{ city: 'Seattle', fare: 27.5 }],
        headers: ['city', 'fare'],
        summary: '1 row',
      });

      const dataPath = join(tempDir, 'api/_data/uber-rides.json');
      expect(existsSync(dataPath)).toBe(true);
      expect(existsSync(join(tempDir, 'api/_data/protected-data.ts'))).toBe(true);
      expect(existsSync(join(tempDir, 'src/data/uber-rides.json'))).toBe(false);
      const data = JSON.parse(await readFile(dataPath, 'utf-8'));
      expect(data.rows[0]).toEqual({ city: 'Seattle', fare: 27.5 });
      expect(data.summary).toBe('1 row');
      const serverModule = await readFile(join(tempDir, 'api/_data/protected-data.ts'), 'utf-8');
      expect(serverModule).toContain('PROTECTED_DASHBOARD_DATA');
      expect(serverModule).toContain('uber-rides');
    });

    it('should reject unsafe protected dashboard data names', async () => {
      await ts.scaffold(tempDir, { boardName: 'data-safe', boardTitle: 'Data Safe' });

      await expect(
        ts.writeProtectedDashboardData(tempDir, '../package.json', { rows: [] }),
      ).rejects.toThrow(/Unsafe dashboard data name/);
    });

    it('should delete one dashboard\'s protected data while keeping the others', async () => {
      await ts.scaffold(tempDir, { boardName: 'multi', boardTitle: 'Multi' });
      await ts.writeProtectedDashboardData(tempDir, 'Zomato', { rows: [{ a: 1 }], summary: 'z' });
      await ts.writeProtectedDashboardData(tempDir, 'Urban Clap', { rows: [{ b: 2 }], summary: 'u' });

      await ts.deleteProtectedDashboardData(tempDir, 'Zomato');

      expect(existsSync(join(tempDir, 'api/_data/zomato.json'))).toBe(false);
      expect(existsSync(join(tempDir, 'api/_data/urban-clap.json'))).toBe(true);

      const aggregate = JSON.parse(await readFile(join(tempDir, 'api/_data/dashboard-data.json'), 'utf-8'));
      expect(aggregate.zomato).toBeUndefined();
      expect(aggregate['urban-clap']).toBeDefined();

      const serverModule = await readFile(join(tempDir, 'api/_data/protected-data.ts'), 'utf-8');
      expect(serverModule).not.toContain('zomato');
      expect(serverModule).toContain('urban-clap');
    });

    it('should no-op when deleting protected data that does not exist', async () => {
      await ts.scaffold(tempDir, { boardName: 'noop', boardTitle: 'Noop' });
      await expect(ts.deleteProtectedDashboardData(tempDir, 'Nonexistent')).resolves.toBeUndefined();
    });

    it('should not escape src when deleting an unsafe generated path', async () => {
      await ts.scaffold(tempDir, { boardName: 'guard', boardTitle: 'Guard' });
      const pkgPath = join(tempDir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);

      await expect(ts.deleteGeneratedFile(tempDir, '../package.json')).rejects.toThrow();
      expect(existsSync(pkgPath)).toBe(true);
    });

    it('should delete an allowlisted generated component file', async () => {
      await ts.scaffold(tempDir, { boardName: 'comp', boardTitle: 'Comp' });
      await ts.writeGeneratedFile(tempDir, 'components/ZomatoDashboard.tsx', 'export const ZomatoDashboard = () => null;');
      const compPath = join(tempDir, 'src/components/ZomatoDashboard.tsx');
      expect(existsSync(compPath)).toBe(true);

      await ts.deleteGeneratedFile(tempDir, 'components/ZomatoDashboard.tsx');
      expect(existsSync(compPath)).toBe(false);
    });
  });
});
