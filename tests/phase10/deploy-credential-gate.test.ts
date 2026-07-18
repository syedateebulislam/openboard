/**
 * Phase 10 — Deployment credential-injection gate (security review finding #4).
 *
 * ProjectManager.deploy must not continue to `vercel --prod` when dashboard
 * credential env vars could not be set on the Vercel project — otherwise the
 * deployed dashboard's auth silently runs with stale or missing credentials.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectManager } from '../../src/services/project/ProjectManager.js';
import { VercelService } from '../../src/services/deploy/VercelService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openboard-gate-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ProjectManager.deploy credential gate', () => {
  let projectsRoot: string;
  let configDir: string;
  let pm: ProjectManager;

  beforeEach(() => {
    projectsRoot = makeTempDir();
    configDir = makeTempDir();
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'deploy-gate-test-secret';
    pm = new ProjectManager(projectsRoot);

    const cfg = new ConfigService(configDir);
    cfg.set('credentials.username', 'admin');
    cfg.setEncrypted('credentials.passwordHash', '$2b$12$hash');
    cfg.setEncrypted('credentials.jwtSecret', 'jwt-secret');

    vi.spyOn(pm, 'preDeployChecks').mockReturnValue({ success: true });
    vi.spyOn(VercelService, 'checkAuthenticated').mockResolvedValue({ success: true });
    vi.spyOn(VercelService, 'ensureLinked').mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectsRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
  });

  it('should deploy when credential injection succeeds', async () => {
    vi.spyOn(VercelService, 'injectCredentials').mockResolvedValue(true);
    const deploySpy = vi.spyOn(VercelService, 'deployProduction')
      .mockResolvedValue({ success: true, url: 'https://ok.vercel.app' });

    const result = await pm.deploy(projectsRoot);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://ok.vercel.app');
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it('should fail and skip deployment when credential injection fails', async () => {
    vi.spyOn(VercelService, 'injectCredentials').mockResolvedValue(false);
    const deploySpy = vi.spyOn(VercelService, 'deployProduction');

    const result = await pm.deploy(projectsRoot);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credential/i);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('injectCredentials should report failure when a Vercel env var cannot be set', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '.vercel'), { recursive: true });
    vi.spyOn(VercelService, 'checkAuthenticated').mockResolvedValue({ success: true });
    vi.spyOn(VercelService, 'setEnvVar').mockResolvedValue(false);

    const ok = await VercelService.injectCredentials(dir, {
      username: 'admin',
      passwordHash: '$2b$12$hash',
      jwtSecret: 'jwt-secret',
    });

    expect(ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('injectCredentials should succeed when all Vercel env vars are set', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '.vercel'), { recursive: true });
    vi.spyOn(VercelService, 'checkAuthenticated').mockResolvedValue({ success: true });
    vi.spyOn(VercelService, 'setEnvVar').mockResolvedValue(true);

    const ok = await VercelService.injectCredentials(dir, {
      username: 'admin',
      passwordHash: '$2b$12$hash',
      jwtSecret: 'jwt-secret',
    });

    expect(ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
