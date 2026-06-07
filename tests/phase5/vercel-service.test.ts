/**
 * PHASE 5: VercelService Tests
 *
 * Tests the CLI-based VercelService which uses `vercel` CLI via crossSpawn
 * and `node:child_process` spawn for stdin-piped commands (setEnvVar).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VercelService } from '../../src/services/deploy/VercelService.js';
import { crossSpawn } from '../../src/utils/crossSpawn.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/utils/crossSpawn.js', () => ({
  crossSpawn: vi.fn(),
  resolveSpawnInvocation: (cmd: string, args: string[]) => ({ command: cmd, args, useShell: false }),
  IS_WINDOWS: false,
  IS_MAC: false,
  IS_LINUX: true,
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn((event: string, cb: (code?: number) => void) => {
      if (event === 'close') setImmediate(() => cb(0));
    }),
  })),
}));

const mockCrossSpawn = vi.mocked(crossSpawn);
const mockSpawn = vi.mocked(spawn);
let testConfigDir: string | undefined;

function mockSuccess(stdout = '', stderr = '') {
  return { stdout, stderr, code: 0 };
}

function mockFailure(stderr = 'error', code = 1) {
  return { stdout: '', stderr, code };
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `vercel-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('VercelService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    testConfigDir = makeTempDir();
    process.env.OPENBOARD_CONFIG_DIR = testConfigDir;
    delete process.env.VERCEL_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (testConfigDir) {
      rmSync(testConfigDir, { recursive: true, force: true });
      testConfigDir = undefined;
    }
    delete process.env.OPENBOARD_CONFIG_DIR;
  });

  // -------------------------------------------------------------------------
  // checkVercelInstalled
  // -------------------------------------------------------------------------

  describe('checkVercelInstalled', () => {
    it('should return true when vercel --version succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Vercel CLI 33.0.0'));
      const result = await VercelService.checkVercelInstalled();
      expect(result).toBe(true);
    });

    it('should return false when vercel is not found', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('not found'));
      const result = await VercelService.checkVercelInstalled();
      expect(result).toBe(false);
    });
  });

  describe('checkAuthenticated', () => {
    it('should return success when vercel whoami succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('user@example.com'));

      const result = await VercelService.checkAuthenticated('/test/project');

      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'vercel',
        ['whoami'],
        expect.objectContaining({ cwd: '/test/project' }),
      );
    });

    it('should return an actionable error when vercel credentials are invalid', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('Error: The specified token is not valid.'));

      const result = await VercelService.checkAuthenticated('/test/project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vercel is not authenticated.');
      expect(result.error).toContain('Re-enter the Vercel token');
    });

    it('should pass saved Vercel tokens to CLI auth and env auth', async () => {
      new ConfigService().setEncrypted('vercel.token', 'vcp_test_token_123');
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('user@example.com'));

      const result = await VercelService.checkAuthenticated('/test/project');

      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'vercel',
        ['whoami', '--token', 'vcp_test_token_123'],
        expect.objectContaining({
          env: expect.objectContaining({ VERCEL_TOKEN: 'vcp_test_token_123' }),
        }),
      );
    });

    it('should ignore malformed saved Vercel tokens instead of passing invalid CLI token values', async () => {
      new ConfigService().setEncrypted('vercel.token', 'vercel-token-with:colon');
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('user@example.com'));

      const result = await VercelService.checkAuthenticated('/test/project');

      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'vercel',
        ['whoami'],
        expect.objectContaining({
          env: expect.objectContaining({ VERCEL_TOKEN: undefined }),
        }),
      );
    });
  });

  describe('validateTokenForProjectAccess', () => {
    it('should validate token identity and project access', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ user: { username: 'user' } }) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ projects: [] }) });
      vi.stubGlobal('fetch', fetchMock);

      const result = await VercelService.validateTokenForProjectAccess('vcp_test_token_123');

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.vercel.com/v2/user',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer vcp_test_token_123' }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.vercel.com/v9/projects',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer vcp_test_token_123' }),
        }),
      );
    });

    it('should reject tokens without Vercel project scope access', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ user: { username: 'user' } }) })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({
            error: {
              message: 'Not authorized: use a token with access to this scope.',
              scope: 'example-projects',
            },
          }),
        }));

      const result = await VercelService.validateTokenForProjectAccess('vcp_test_token_123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vercel is not authenticated.');
      expect(result.error).toContain('access to the personal/team scope');
      expect(result.error).toContain('example-projects');
    });
  });

  // -------------------------------------------------------------------------
  // isVercelProject
  // -------------------------------------------------------------------------

  describe('isVercelProject', () => {
    it('should return true if .vercel directory exists', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });

      const result = await VercelService.isVercelProject(dir);
      expect(result).toBe(true);

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return false if .vercel does not exist', async () => {
      const result = await VercelService.isVercelProject('/nonexistent');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // link
  // -------------------------------------------------------------------------

  describe('link', () => {
    it('should run vercel link --yes and return success', async () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'OpenBoard Workspace' }));
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Linked to project'));
      const result = await VercelService.link(dir);
      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'vercel',
        ['link', '--yes', '--project', 'openboard-workspace'],
        expect.objectContaining({ cwd: dir }),
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it('should include configured Vercel team when linking', async () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'openboard-workspace' }));
      new ConfigService().set('vercel.teamId', 'team_123');
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Linked to project'));

      const result = await VercelService.link(dir);

      expect(result.success).toBe(true);
      expect(mockCrossSpawn.mock.calls[0][1]).toEqual([
        'link',
        '--yes',
        '--project',
        'openboard-workspace',
        '--team',
        'team_123',
      ]);
      rmSync(dir, { recursive: true, force: true });
    });

    it('should link through Vercel API when a token is configured', async () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'OpenBoard Workspace' }));
      new ConfigService().setEncrypted('vercel.token', 'vcp_test_token_123');
      const fetchMock = vi.fn().mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({
          id: 'prj_123',
          accountId: 'team_123',
          name: 'openboard-workspace',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await VercelService.link(dir);

      expect(result.success).toBe(true);
      expect(mockCrossSpawn).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.vercel.com/v9/projects/openboard-workspace',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ authorization: 'Bearer vcp_test_token_123' }),
        }),
      );
      expect(JSON.parse(readFileSync(join(dir, '.vercel', 'project.json'), 'utf-8'))).toEqual({
        orgId: 'team_123',
        projectId: 'prj_123',
      });

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return a scope access error when Vercel API rejects project lookup', async () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'openboard-workspace' }));
      new ConfigService().setEncrypted('vercel.token', 'vcp_test_token_123');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        status: 403,
        text: async () => JSON.stringify({
          error: {
            code: 'forbidden',
            message: 'Not authorized: use a token with access to this scope.',
            scope: 'example-projects',
          },
        }),
      }));

      const result = await VercelService.link(dir);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vercel is not authenticated.');
      expect(result.error).toContain('access to the personal/team scope');
      expect(result.error).toContain('example-projects');
      expect(mockCrossSpawn).not.toHaveBeenCalled();

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return error on link failure', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('Not authenticated'));
      const result = await VercelService.link('/test/project');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not authenticated');
    });

    it('should return error when link throws', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('spawn failed'));
      const result = await VercelService.link('/test');
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // ensureLinked
  // -------------------------------------------------------------------------

  describe('ensureLinked', () => {
    it('should skip link if .vercel directory exists', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });

      const result = await VercelService.ensureLinked(dir);
      expect(result.success).toBe(true);
      expect(mockCrossSpawn).not.toHaveBeenCalled();

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return error if vercel CLI not installed', async () => {
      const dir = makeTempDir();

      mockCrossSpawn.mockRejectedValueOnce(new Error('not found'));

      const result = await VercelService.ensureLinked(dir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');

      rmSync(dir, { recursive: true, force: true });
    });

    it('should call link if .vercel does not exist and vercel is installed', async () => {
      const dir = makeTempDir();

      // checkVercelInstalled
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Vercel CLI 33.0.0'));
      // link
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Linked'));

      const result = await VercelService.ensureLinked(dir);
      expect(result.success).toBe(true);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // deploy
  // -------------------------------------------------------------------------

  describe('deploy', () => {
    it('should deploy with --yes flag', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess()); // checkVercelInstalled
      mockCrossSpawn.mockResolvedValueOnce(
        mockSuccess('https://my-board-abc123.vercel.app'),
      );

      const result = await VercelService.deploy('/test/project', false);
      expect(result.success).toBe(true);
      expect(result.url).toBe('https://my-board-abc123.vercel.app');
    });

    it('should deploy with --yes --prod for production', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(
        mockSuccess('https://my-board.vercel.app'),
      );

      const result = await VercelService.deploy('/test/project', true);
      expect(result.success).toBe(true);

      const deployCall = mockCrossSpawn.mock.calls[1];
      expect(deployCall[1]).toContain('--prod');
    });

    it('should pass saved Vercel tokens to deploy CLI auth and env auth', async () => {
      new ConfigService().setEncrypted('vercel.token', 'vcp_test_token_123');
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('https://my-board.vercel.app'));

      const result = await VercelService.deploy('/test/project', true);

      expect(result.success).toBe(true);
      const deployCall = mockCrossSpawn.mock.calls[1];
      expect(deployCall[1]).toEqual(['--yes', '--prod', '--token', 'vcp_test_token_123']);
      expect(deployCall[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({ VERCEL_TOKEN: 'vcp_test_token_123' }),
      }));
    });

    it('should extract vercel.app URL from output', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(
        mockSuccess('Deployed to https://openboard-finance-abc123.vercel.app\nReady!'),
      );

      const result = await VercelService.deploy('/test');
      expect(result.url).toBe('https://openboard-finance-abc123.vercel.app');
    });

    it('should return error when vercel CLI not installed', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('not found'));

      const result = await VercelService.deploy('/test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('should return error on deploy failure', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockFailure('Build failed'));

      const result = await VercelService.deploy('/test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Build failed');
    });

    it('should relink and retry when Vercel project settings cannot be loaded', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });
      writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: 'old-project' }));

      mockCrossSpawn.mockResolvedValueOnce(mockSuccess()); // checkVercelInstalled
      mockCrossSpawn.mockResolvedValueOnce(mockFailure(
        'Error: Could not retrieve Project Settings. To link your Project, remove the `.vercel` directory and deploy again.\nLearn More: https://vercel.link/cannot-load-project-settings',
      ));
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess()); // checkVercelInstalled inside ensureLinked
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('Linked')); // vercel link --yes
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('https://my-board.vercel.app')); // retry deploy

      const progress: string[] = [];
      const result = await VercelService.deploy(dir, true, line => progress.push(line));

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://my-board.vercel.app');
      expect(existsSync(join(dir, '.vercel'))).toBe(false);
      expect(progress).toContain('Vercel project link is stale. Re-linking project and retrying deploy...');
      expect(mockCrossSpawn.mock.calls[3][1]).toEqual(['link', '--yes', '--project', expect.stringMatching(/^vercel-test-/)]);
      expect(mockCrossSpawn.mock.calls[4][1]).toEqual(['--yes', '--prod']);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // deployProduction / deployPreview
  // -------------------------------------------------------------------------

  describe('deployProduction', () => {
    it('should call deploy with production=true', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('https://app.vercel.app'));

      const result = await VercelService.deployProduction('/test');
      expect(result.success).toBe(true);
    });
  });

  describe('deployPreview', () => {
    it('should call deploy with production=false', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockSuccess('https://preview.vercel.app'));

      const result = await VercelService.deployPreview('/test');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // writeEnvFile
  // -------------------------------------------------------------------------

  describe('writeEnvFile', () => {
    it('should write key=value pairs to .env file', () => {
      const dir = makeTempDir();

      VercelService.writeEnvFile(dir, {
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD_HASH: '$2b$12$testhash',
        JWT_SECRET: 'abc123secret',
      });

      const envContent = readFileSync(join(dir, '.env'), 'utf-8');
      expect(envContent).toContain('DASHBOARD_USERNAME=admin');
      expect(envContent).toContain('DASHBOARD_PASSWORD_HASH=$2b$12$testhash');
      expect(envContent).toContain('JWT_SECRET=abc123secret');

      rmSync(dir, { recursive: true, force: true });
    });

    it('should overwrite existing .env file', () => {
      const dir = makeTempDir();

      VercelService.writeEnvFile(dir, { OLD_KEY: 'old_value' });
      VercelService.writeEnvFile(dir, { NEW_KEY: 'new_value' });

      const envContent = readFileSync(join(dir, '.env'), 'utf-8');
      expect(envContent).not.toContain('OLD_KEY');
      expect(envContent).toContain('NEW_KEY=new_value');

      rmSync(dir, { recursive: true, force: true });
    });

    it('should quote multiline and special values safely in .env', () => {
      const dir = makeTempDir();

      VercelService.writeEnvFile(dir, {
        SAFE_VALUE: 'one two',
        MULTILINE: 'line1\nline2',
        QUOTED: 'a"b',
      });

      const envContent = readFileSync(join(dir, '.env'), 'utf-8');
      expect(envContent).toContain('SAFE_VALUE="one two"');
      expect(envContent).toContain('MULTILINE="line1\\nline2"');
      expect(envContent).toContain('QUOTED="a\\"b"');

      rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // injectCredentials
  // -------------------------------------------------------------------------

  describe('injectCredentials', () => {
    it('should write .env file with all 3 credential keys', async () => {
      const dir = makeTempDir();

      const result = await VercelService.injectCredentials(dir, {
        username: 'admin',
        passwordHash: '$2b$12$hash',
        jwtSecret: 'secret123',
      });

      expect(result).toBe(true);

      const envContent = readFileSync(join(dir, '.env'), 'utf-8');
      expect(envContent).toContain('DASHBOARD_USERNAME=admin');
      expect(envContent).toContain('DASHBOARD_PASSWORD_HASH=$2b$12$hash');
      expect(envContent).toContain('JWT_SECRET=secret123');

      rmSync(dir, { recursive: true, force: true });
    });

    it('should skip Vercel env vars if .vercel does not exist', async () => {
      const dir = makeTempDir();

      await VercelService.injectCredentials(dir, {
        username: 'admin',
        passwordHash: 'hash',
        jwtSecret: 'secret',
      });

      expect(existsSync(join(dir, '.env'))).toBe(true);
      expect(mockCrossSpawn).not.toHaveBeenCalled();

      rmSync(dir, { recursive: true, force: true });
    });

    it('should pass saved Vercel tokens while setting env vars', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });
      new ConfigService().setEncrypted('vercel.token', 'vcp_test_token_123');
      mockCrossSpawn.mockResolvedValue(mockSuccess()); // env rm

      const result = await VercelService.setEnvVar(dir, 'DASHBOARD_USERNAME', 'admin', ['production']);

      expect(result).toBe(true);
      expect(mockCrossSpawn.mock.calls[0][1]).toEqual(['env', 'rm', 'DASHBOARD_USERNAME', 'production', '--yes', '--token', 'vcp_test_token_123']);
      expect(mockCrossSpawn.mock.calls[0][2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({ VERCEL_TOKEN: 'vcp_test_token_123' }),
      }));
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/^vercel(\.cmd)?$/),
        ['env', 'add', 'DASHBOARD_USERNAME', 'production', '--token', 'vcp_test_token_123'],
        expect.objectContaining({
          env: expect.objectContaining({ VERCEL_TOKEN: 'vcp_test_token_123' }),
        }),
      );

      rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // getProjectInfo
  // -------------------------------------------------------------------------

  describe('getProjectInfo', () => {
    it('should return null if .vercel/project.json does not exist', async () => {
      const info = await VercelService.getProjectInfo('/nonexistent');
      expect(info).toBeNull();
    });

    it('should parse name from project.json', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });
      writeFileSync(
        join(dir, '.vercel', 'project.json'),
        JSON.stringify({ name: 'my-dashboard', url: 'https://my-dashboard.vercel.app' }),
      );

      const info = await VercelService.getProjectInfo(dir);
      expect(info).not.toBeNull();
      expect(info!.name).toBe('my-dashboard');

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return null on invalid JSON', async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, '.vercel'), { recursive: true });
      writeFileSync(join(dir, '.vercel', 'project.json'), 'invalid json');

      const info = await VercelService.getProjectInfo(dir);
      expect(info).toBeNull();

      rmSync(dir, { recursive: true, force: true });
    });
  });
});
