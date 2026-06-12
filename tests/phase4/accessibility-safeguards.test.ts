import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldReduceLoadingMotion } from '../../src/components/LoadingRemark.js';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { buildComponentGenerationPrompt } from '../../src/services/llm/prompts/componentGenerationPrompt.js';
import { buildDataProcessingPrompt } from '../../src/services/llm/prompts/dataProcessingPrompt.js';

describe('Accessibility safeguards', () => {
  it('should scaffold dashboard tabs with semantic tab roles', () => {
    const app = readFileSync(join(process.cwd(), 'templates/dashboard/src/App.tsx'), 'utf-8');

    expect(app).toContain('role="tablist"');
    expect(app).toContain('role="tab"');
    expect(app).toContain('aria-selected="true"');
    expect(app).toContain('aria-controls="panel-welcome"');
    expect(app).toContain('role="tabpanel"');
    expect(app).toContain('aria-labelledby="tab-welcome"');
  });

  it('should keep template focus and contrast hooks visible', () => {
    const css = readFileSync(join(process.cwd(), 'templates/dashboard/src/App.css'), 'utf-8');

    expect(css).toContain('--text-secondary: #c9c3b9');
    expect(css).toContain('--border: #56524a');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('outline: 2px solid');
  });

  it('should instruct the LLM to preserve accessible tabs and charts', () => {
    expect(SYSTEM_PROMPT).toContain('role="tablist"');
    expect(SYSTEM_PROMPT).toContain('aria-selected');
    expect(SYSTEM_PROMPT).toContain('role="tabpanel"');
    expect(SYSTEM_PROMPT).toContain('must not rely on color alone');

    const componentPrompt = buildComponentGenerationPrompt('Chart', 'test', 'type Row = {}', 'rows', '<div />');
    expect(componentPrompt).toContain('visible title or aria-label');
    expect(componentPrompt).toContain('do not rely on color alone');
  });

  it('should keep generated auth and dashboard data server protected', () => {
    const authApi = readFileSync(join(process.cwd(), 'templates/dashboard/api/auth.ts'), 'utf-8');
    const sharedAuthApi = readFileSync(join(process.cwd(), 'templates/dashboard/api/_auth.ts'), 'utf-8');
    const dataApi = readFileSync(join(process.cwd(), 'templates/dashboard/api/dashboard-data.ts'), 'utf-8');
    const authProvider = readFileSync(join(process.cwd(), 'templates/dashboard/src/components/AuthProvider.tsx'), 'utf-8');
    const dataHook = readFileSync(join(process.cwd(), 'templates/dashboard/src/hooks/useProtectedDashboardData.ts'), 'utf-8');

    expect(sharedAuthApi).toContain('HttpOnly');
    expect(sharedAuthApi).toContain('SameSite=Strict');
    expect(authApi).toContain('buildAuthCookie');
    expect(authProvider).not.toContain('localStorage');
    expect(authProvider).not.toContain('window.location.hostname');
    expect(authProvider).not.toContain("username: 'dev'");
    expect(dataApi).toContain('requireAuth');
    expect(dataApi).toContain('./_data/protected-data');
    expect(dataHook).toContain('/api/dashboard-data');
    expect(dataHook).toContain('credentials: \'include\'');
    expect(SYSTEM_PROMPT).toContain('Do NOT embed raw dashboard rows');
    expect(SYSTEM_PROMPT).toContain('Do NOT add localhost, preview, hostname, URL, or environment based auth bypasses');
    expect(SYSTEM_PROMPT).toContain('NEVER set isAuthenticated/user/client auth state from window.location');
    expect(SYSTEM_PROMPT).toContain('useProtectedDashboardData');

    const dataPrompt = buildDataProcessingPrompt('type Row = {}', 'summary', '[{"secret":"value"}]', 'reference');
    expect(dataPrompt).toContain('Does NOT export or embed raw rows');
    expect(dataPrompt).toContain('accept rows as function parameters');
  });

  it('should set baseline Vercel security headers', () => {
    const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'templates/dashboard/vercel.json'), 'utf-8'));
    const headers = vercelConfig.headers?.find((entry: any) => entry.source === '/(.*)')?.headers ?? [];
    const values = new Map(headers.map((header: any) => [header.key, header.value]));

    expect(values.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(values.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(values.get('Content-Security-Policy')).toContain("object-src 'none'");
    expect(values.get('X-Frame-Options')).toBe('DENY');
    expect(values.get('X-Content-Type-Options')).toBe('nosniff');
    expect(values.get('Referrer-Policy')).toBe('no-referrer');
    expect(values.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('should allow users and automation to disable animated loading remarks', () => {
    expect(shouldReduceLoadingMotion({ OPENBOARD_REDUCE_MOTION: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldReduceLoadingMotion({ OPENBOARD_REDUCE_MOTION: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldReduceLoadingMotion({ NO_COLOR: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldReduceLoadingMotion({ CI: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldReduceLoadingMotion({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
