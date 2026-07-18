/**
 * Phase 10 — Vercel token hygiene (security review finding #3).
 *
 * Saved Vercel tokens must be passed to the CLI exclusively via the
 * VERCEL_TOKEN environment variable. `--token <secret>` command-line
 * arguments are visible to process inspection (Task Manager, ps, procmon)
 * and must never appear in spawned argv.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VercelService } from '../../src/services/deploy/VercelService.js';
import { crossSpawn } from '../../src/utils/crossSpawn.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
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

const mockCrossSpawn = vi.mocked(crossSpawn);
const TOKEN = 'vcp_secret_token_abc';
let testConfigDir: string | undefined;

function mockSuccess(stdout = '', stderr = '') {
  return { stdout, stderr, code: 0 };
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `vercel-hygiene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function allSpawnedArgs(): string[][] {
  return mockCrossSpawn.mock.calls.map(call => call[1]);
}

function expectNoTokenInArgv(): void {
  for (const args of allSpawnedArgs()) {
    expect(args).not.toContain('--token');
    expect(args).not.toContain(TOKEN);
  }
}

describe('Vercel token hygiene', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    testConfigDir = makeTempDir();
    process.env.OPENBOARD_CONFIG_DIR = testConfigDir;
    delete process.env.VERCEL_TOKEN;
    delete process.env.OPENBOARD_VERCEL_TOKEN;
    new ConfigService().setEncrypted('vercel.token', TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (testConfigDir) {
      rmSync(testConfigDir, { recursive: true, force: true });
      testConfigDir = undefined;
    }
    delete process.env.OPENBOARD_CONFIG_DIR;
  });

  it('checkAuthenticated validates saved tokens through bearer auth, never argv', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"projects":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await VercelService.checkAuthenticated('/test/project');

    expect(result.success).toBe(true);
    expect(mockCrossSpawn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }));
    }
    expectNoTokenInArgv();
  });

  it('deploy authenticates via VERCEL_TOKEN env, never argv', async () => {
    mockCrossSpawn.mockResolvedValueOnce(mockSuccess()); // checkVercelInstalled
    mockCrossSpawn.mockResolvedValueOnce(mockSuccess('https://my-board.vercel.app'));

    const result = await VercelService.deploy('/test/project', true);

    expect(result.success).toBe(true);
    const deployCall = mockCrossSpawn.mock.calls[1];
    expect(deployCall[1]).toEqual(['--yes', '--prod']);
    expect(deployCall[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ VERCEL_TOKEN: TOKEN }),
    }));
    expectNoTokenInArgv();
  });

  it('setEnvVar authenticates via VERCEL_TOKEN env, never argv', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '.vercel'), { recursive: true });
    mockCrossSpawn.mockResolvedValue(mockSuccess()); // env rm

    const result = await VercelService.setEnvVar(dir, 'DASHBOARD_USERNAME', 'admin', ['production']);

    expect(result).toBe(true);
    expect(mockCrossSpawn.mock.calls[0][1]).toEqual(['env', 'rm', 'DASHBOARD_USERNAME', 'production', '--yes']);
    expect(mockCrossSpawn.mock.calls[0][2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ VERCEL_TOKEN: TOKEN }),
    }));
    expect(mockCrossSpawn).toHaveBeenNthCalledWith(
      2,
      'vercel',
      ['env', 'add', 'DASHBOARD_USERNAME', 'production'],
      expect.objectContaining({
        env: expect.objectContaining({ VERCEL_TOKEN: TOKEN }),
        stdin: 'admin',
      }),
    );
    expectNoTokenInArgv();

    rmSync(dir, { recursive: true, force: true });
  });

  it('listDeployments authenticates via VERCEL_TOKEN env, never argv', async () => {
    mockCrossSpawn.mockResolvedValueOnce(mockSuccess('deployments'));

    const result = await VercelService.listDeployments('/test/project');

    expect(result.success).toBe(true);
    expectNoTokenInArgv();
  });
});
