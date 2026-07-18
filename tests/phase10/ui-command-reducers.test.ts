import { describe, expect, it, vi } from 'vitest';
import { ProjectCommandHandlers } from '../../src/services/commands/ProjectCommandHandlers.js';
import type { ProjectManager } from '../../src/services/project/ProjectManager.js';
import { setupWizardNavigationReducer, visibleWizardSteps } from '../../src/screens/setupWizardReducer.js';

describe('setup reducer', () => {
  it('skips deployment credentials in local and hybrid modes', () => {
    expect(visibleWizardSteps('local')).toEqual(['mode', 'llm', 'credentials']);
    expect(visibleWizardSteps('hybrid')).toEqual(['mode', 'llm', 'credentials']);
    const selected = setupWizardNavigationReducer(
      { step: 'mode', mode: 'remote' },
      { type: 'select_mode', mode: 'local' },
    );
    expect(setupWizardNavigationReducer(selected, { type: 'llm_complete' }).step).toBe('credentials');
  });

  it('walks remote setup through GitHub and Vercel', () => {
    let state = setupWizardNavigationReducer(
      { step: 'mode', mode: 'local' },
      { type: 'select_mode', mode: 'remote' },
    );
    state = setupWizardNavigationReducer(state, { type: 'llm_complete' });
    expect(state.step).toBe('github');
    state = setupWizardNavigationReducer(state, { type: 'github_complete' });
    expect(state.step).toBe('vercel');
    expect(setupWizardNavigationReducer(state, { type: 'vercel_complete' }).step).toBe('credentials');
  });
});

describe('project command handlers', () => {
  function manager(overrides: Record<string, unknown> = {}) {
    return {
      getProjectInfo: () => ({ hasNodeModules: true }),
      install: vi.fn(async () => ({ success: true })),
      build: vi.fn(async () => ({ success: true, outputDir: 'dist' })),
      isPreviewRunning: () => false,
      stopPreview: vi.fn(),
      preview: vi.fn(async () => ({ success: true, url: 'http://127.0.0.1:5180' })),
      ...overrides,
    } as unknown as ProjectManager;
  }

  it('auto-installs before build and returns a single command result', async () => {
    const install = vi.fn(async () => ({ success: true }));
    const project = manager({ getProjectInfo: () => ({ hasNodeModules: false }), install });
    const logs: string[] = [];
    const result = await new ProjectCommandHandlers(project).build('workspace', (line) => logs.push(line));
    expect(result.success).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(logs).toContain('Build complete. Output: dist');
  });

  it('restarts, rebuilds, and reports the actual preview URL', async () => {
    const stopPreview = vi.fn();
    const build = vi.fn(async () => ({ success: true, outputDir: 'dist' }));
    const project = manager({ isPreviewRunning: () => true, stopPreview, build });
    const logs: string[] = [];
    const result = await new ProjectCommandHandlers(project).preview('workspace', (line) => logs.push(line));
    expect(result).toEqual({ success: true, url: 'http://127.0.0.1:5180' });
    expect(stopPreview).toHaveBeenCalledWith('workspace');
    expect(build).toHaveBeenCalledOnce();
    expect(logs.at(-1)).toBe('Preview running at http://127.0.0.1:5180');
  });
});

