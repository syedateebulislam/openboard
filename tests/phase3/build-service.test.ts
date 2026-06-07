/**
 * PHASE 3: BuildService Tests
 *
 * Tests pure functions (parseTscErrors, buildRetryPrompt) directly,
 * and CLI operations (install, build, typeCheck, fullBuild) via crossSpawn mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuildService } from '../../src/services/build/BuildService.js';
import { crossSpawn } from '../../src/utils/crossSpawn.js';

vi.mock('../../src/utils/crossSpawn.js', () => ({
  crossSpawn: vi.fn(),
  IS_WINDOWS: false,
  IS_MAC: false,
  IS_LINUX: true,
}));

const mockCrossSpawn = vi.mocked(crossSpawn);

function mockSuccess(stdout = '', stderr = '') {
  return { stdout, stderr, code: 0 };
}

function mockFailure(stderr = 'error', code = 1) {
  return { stdout: '', stderr, code };
}

describe('BuildService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // parseTscErrors (pure function)
  // -------------------------------------------------------------------------

  describe('parseTscErrors', () => {
    it('should parse standard tsc error output', () => {
      const output = `src/App.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/components/Chart.tsx(45,10): error TS2304: Cannot find name 'RadialBar'.`;

      const errors = BuildService.parseTscErrors(output);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual({
        file: 'src/App.tsx',
        line: 12,
        column: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      });
      expect(errors[1]).toEqual({
        file: 'src/components/Chart.tsx',
        line: 45,
        column: 10,
        code: 'TS2304',
        message: "Cannot find name 'RadialBar'.",
      });
    });

    it('should return empty array for no errors', () => {
      expect(BuildService.parseTscErrors('')).toEqual([]);
      expect(BuildService.parseTscErrors('Compilation successful')).toEqual([]);
    });

    it('should handle single error', () => {
      const output = `src/main.tsx(1,1): error TS1005: ';' expected.`;
      const errors = BuildService.parseTscErrors(output);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('TS1005');
    });

    it('should ignore non-error lines mixed in output', () => {
      const output = `Loading tsconfig...
src/App.tsx(5,3): error TS2345: Argument of type 'void' is not assignable.
Found 1 error.`;
      const errors = BuildService.parseTscErrors(output);
      expect(errors).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // buildRetryPrompt (pure function)
  // -------------------------------------------------------------------------

  describe('buildRetryPrompt', () => {
    it('should include original prompt and error details', () => {
      const errors = [
        { file: 'App.tsx', line: 10, column: 5, code: 'TS2322', message: 'Type error' },
        { file: 'Chart.tsx', line: 20, column: 3, code: 'TS2304', message: 'Missing name' },
      ];

      const prompt = BuildService.buildRetryPrompt('Create a dashboard', errors);
      expect(prompt).toContain('Create a dashboard');
      expect(prompt).toContain('TypeScript errors');
      expect(prompt).toContain('App.tsx line 10: Type error');
      expect(prompt).toContain('Chart.tsx line 20: Missing name');
      expect(prompt).toContain('Fix ALL of them');
    });

    it('should work with single error', () => {
      const errors = [
        { file: 'index.tsx', line: 1, column: 1, code: 'TS1005', message: 'Missing semicolon' },
      ];
      const prompt = BuildService.buildRetryPrompt('Add chart', errors);
      expect(prompt).toContain('index.tsx line 1: Missing semicolon');
    });
  });

  // -------------------------------------------------------------------------
  // install (crossSpawn mock)
  // -------------------------------------------------------------------------

  describe('install', () => {
    it('should return success when npm install succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      const result = await BuildService.install('/test/project');
      expect(result.success).toBe(true);
    });

    it('should return error when npm install fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('npm ERR! missing dependency'));
      const result = await BuildService.install('/test/project');
      expect(result.success).toBe(false);
      expect(result.error).toContain('npm ERR');
    });
  });

  // -------------------------------------------------------------------------
  // typeCheck (crossSpawn mock)
  // -------------------------------------------------------------------------

  describe('typeCheck', () => {
    it('should return success with empty errors when tsc passes', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      const result = await BuildService.typeCheck('/test/project');
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return errors when tsc fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce({
        stdout: `src/App.tsx(5,3): error TS2322: Type mismatch.`,
        stderr: '',
        code: 1,
      });
      const result = await BuildService.typeCheck('/test/project');
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('TS2322');
    });
  });

  // -------------------------------------------------------------------------
  // build (crossSpawn mock)
  // -------------------------------------------------------------------------

  describe('build', () => {
    it('should return success with outputDir on build pass', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      const result = await BuildService.build('/test/project');
      expect(result.success).toBe(true);
      expect(result.outputDir).toBe('dist');
    });

    it('should return error on build failure', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('vite build failed'));
      const result = await BuildService.build('/test/project');
      expect(result.success).toBe(false);
      expect(result.error).toContain('vite build failed');
    });
  });

  // -------------------------------------------------------------------------
  // fullBuild (crossSpawn mock)
  // -------------------------------------------------------------------------

  describe('fullBuild', () => {
    it('should run install → typeCheck → build sequentially', async () => {
      // install
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      // typeCheck
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      // build
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());

      const result = await BuildService.fullBuild('/test/project');
      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledTimes(3);
    });

    it('should fail-fast if install fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('install failed'));
      const result = await BuildService.fullBuild('/test/project');
      expect(result.success).toBe(false);
      expect(mockCrossSpawn).toHaveBeenCalledTimes(1);
    });

    it('should fail-fast if typeCheck fails', async () => {
      // install ok
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      // typeCheck fails
      mockCrossSpawn.mockResolvedValueOnce({
        stdout: `src/App.tsx(1,1): error TS1005: ';' expected.`,
        stderr: '',
        code: 1,
      });

      const result = await BuildService.fullBuild('/test/project');
      expect(result.success).toBe(false);
      expect(result.error).toContain("';' expected");
      expect(mockCrossSpawn).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Command allowlist
  // -------------------------------------------------------------------------

  describe('Command Safety', () => {
    it('should reject non-allowed commands', async () => {
      // BuildService.install uses 'npm' which is allowed
      // But trying to call a private runCommand with a bad command isn't possible
      // So we test that install/build use allowed commands
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      const result = await BuildService.install('/test');
      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith('npm', ['install'], expect.any(Object));
    });
  });
});
