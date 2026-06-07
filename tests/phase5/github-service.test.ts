/**
 * PHASE 5: GitHubService Tests
 *
 * Tests the CLI-based GitHubService which uses `git` and `gh` via crossSpawn.
 * All external CLI calls are mocked at the crossSpawn level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubService } from '../../src/services/deploy/GitHubService.js';
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
let testConfigDir: string | undefined;

function mockSpawnSuccess(stdout = '', stderr = '') {
  return { stdout, stderr, code: 0 };
}

function mockSpawnFailure(stderr = 'error', code = 1) {
  return { stdout: '', stderr, code };
}

describe('GitHubService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    testConfigDir = join(tmpdir(), `github-service-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testConfigDir, { recursive: true });
    process.env.OPENBOARD_CONFIG_DIR = testConfigDir;
  });

  afterEach(() => {
    if (testConfigDir) {
      rmSync(testConfigDir, { recursive: true, force: true });
      testConfigDir = undefined;
    }
    delete process.env.OPENBOARD_CONFIG_DIR;
  });

  // -------------------------------------------------------------------------
  // checkGitInstalled
  // -------------------------------------------------------------------------

  describe('checkGitInstalled', () => {
    it('should return true when git --version succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('git version 2.40.0'));
      const result = await GitHubService.checkGitInstalled();
      expect(result).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith('git', ['--version'], expect.any(Object));
    });

    it('should return false when git is not found', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('command not found'));
      const result = await GitHubService.checkGitInstalled();
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isGitRepo
  // -------------------------------------------------------------------------

  describe('isGitRepo', () => {
    it('should return true if .git directory exists', async () => {
      const { mkdirSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const dir = join(tmpdir(), `gh-test-${Date.now()}`);
      mkdirSync(join(dir, '.git'), { recursive: true });

      const result = await GitHubService.isGitRepo(dir);
      expect(result).toBe(true);

      rmSync(dir, { recursive: true, force: true });
    });

    it('should return false if .git directory does not exist', async () => {
      const result = await GitHubService.isGitRepo('/nonexistent/path');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // initRepo
  // -------------------------------------------------------------------------

  describe('initRepo', () => {
    it('should return success when git init succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('Initialized empty Git repository'));
      const result = await GitHubService.initRepo('/test/project');
      expect(result.success).toBe(true);
    });

    it('should return error when git init fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure('fatal: not a directory'));
      const result = await GitHubService.initRepo('/bad/path');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a directory');
    });

    it('should return error when git init throws', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('spawn failed'));
      const result = await GitHubService.initRepo('/test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('spawn failed');
    });
  });

  // -------------------------------------------------------------------------
  // commit
  // -------------------------------------------------------------------------

  describe('commit', () => {
    it('should add, commit, and return commit hash on success', async () => {
      // git add .
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      // git status --porcelain (has changes)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('M src/App.tsx'));
      // git config --get user.email
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('dev@example.com'));
      // git config --get user.name
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('Dev User'));
      // git commit -m
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('[main abc1234] Initial commit'));
      // git rev-parse HEAD
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('abc1234567890'));

      const result = await GitHubService.commit('/test/project', 'Initial commit');
      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('abc1234567890');
    });

    it('should replace openboard@local with GitHub noreply author before commit', async () => {
      new ConfigService().set('github.username', 'test-user');

      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git add .
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('M src/App.tsx')); // git status
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('openboard@local')); // git config --get user.email
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('OpenBoard')); // git config --get user.name
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git config user.name
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git config user.email
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('[main abc1234] Initial commit')); // commit
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('abc1234567890')); // rev-parse

      const result = await GitHubService.commit('/test/project', 'Initial commit');

      expect(result.success).toBe(true);
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'git',
        ['config', 'user.email', 'test-user@users.noreply.github.com'],
        expect.objectContaining({ cwd: '/test/project' }),
      );
    });

    it('should return error when no changes to commit', async () => {
      // git add .
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      // git status --porcelain (empty = no changes)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess(''));
      // git log -1 --format=%ae (valid author, no repair needed)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('dev@example.com'));

      const result = await GitHubService.commit('/test/project', 'No changes');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No changes to commit');
    });

    it('should create an empty commit when no files changed but HEAD author is invalid', async () => {
      new ConfigService().set('github.username', 'test-user');

      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git add .
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('')); // git status
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('openboard@local')); // git log author
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('openboard@local')); // git config --get user.email
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('OpenBoard')); // git config --get user.name
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git config user.name
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // git config user.email
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('[main abc1234] Fix OpenBoard deployment author')); // empty commit
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('abc1234567890')); // rev-parse

      const result = await GitHubService.commit('/test/project', 'No changes');

      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('abc1234567890');
      expect(mockCrossSpawn).toHaveBeenCalledWith(
        'git',
        ['commit', '--allow-empty', '-m', 'Fix OpenBoard deployment author'],
        expect.objectContaining({ cwd: '/test/project', useShell: false }),
      );
    });

    it('should return error when git add fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure('fatal: not a git repository'));
      const result = await GitHubService.commit('/test', 'msg');
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // push
  // -------------------------------------------------------------------------

  describe('push', () => {
    it('should push to origin with current branch', async () => {
      // git branch --show-current
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('main'));
      // git push -u origin main
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('Everything up-to-date'));

      const result = await GitHubService.push('/test/project');
      expect(result.success).toBe(true);
      expect(result.pushed).toBe(true);
    });

    it('should return error on push failure', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('main'));
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure('fatal: remote origin not found'));

      const result = await GitHubService.push('/test/project');
      expect(result.success).toBe(false);
      expect(result.error).toContain('remote origin not found');
    });

    it('should default to main when branch --show-current returns empty', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess(''));
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());

      const result = await GitHubService.push('/test/project');
      expect(result.success).toBe(true);
      // Verify it used 'main' as default
      expect(mockCrossSpawn).toHaveBeenLastCalledWith(
        'git',
        ['push', '-u', 'origin', 'main'],
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // isGhCliAvailable / checkGhInstalled
  // -------------------------------------------------------------------------

  describe('isGhCliAvailable', () => {
    it('should return true when gh --version succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('gh version 2.30.0'));
      const result = await GitHubService.isGhCliAvailable();
      expect(result).toBe(true);
    });

    it('should return false when gh is not found', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('not found'));
      const result = await GitHubService.isGhCliAvailable();
      expect(result).toBe(false);
    });
  });

  describe('checkGhInstalled', () => {
    it('should return true when gh auth status succeeds', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('Logged in'));
      const result = await GitHubService.checkGhInstalled();
      expect(result).toBe(true);
    });

    it('should return false when gh auth fails', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('not authenticated'));
      const result = await GitHubService.checkGhInstalled();
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // createRepo
  // -------------------------------------------------------------------------

  describe('createRepo', () => {
    it('should create a private repo via gh CLI and return URL', async () => {
      // isGhCliAvailable (gh --version)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('gh version 2.30.0'));
      // checkGhInstalled (gh auth status)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('Logged in'));
      // gh repo create
      mockCrossSpawn.mockResolvedValueOnce(
        mockSpawnSuccess('https://github.com/testuser/my-board\n'),
      );

      const result = await GitHubService.createRepo('/test/my-board', 'private');
      expect(result.success).toBe(true);
      expect(result.pushed).toBe(true);
      expect(result.repoUrl).toBe('https://github.com/testuser/my-board');
    });

    it('should default to private visibility', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('https://github.com/user/repo'));

      await GitHubService.createRepo('/test/repo');
      // The gh repo create call should include --private
      const ghCall = mockCrossSpawn.mock.calls.find(
        c => c[0] === 'gh' && c[1]?.[0] === 'repo',
      );
      expect(ghCall?.[1]).toContain('--private');
    });

    it('should return error when gh CLI is not available', async () => {
      // isGhCliAvailable fails
      mockCrossSpawn.mockRejectedValueOnce(new Error('not found'));

      const result = await GitHubService.createRepo('/test/repo');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(mockCrossSpawn).toHaveBeenCalledTimes(1);
      expect(mockCrossSpawn.mock.calls.some((call) => ['winget', 'brew', 'sudo'].includes(call[0]))).toBe(false);
    });

    it('should return error when gh repo create fails', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // gh --version
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess()); // gh auth status
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure('name already exists'));

      const result = await GitHubService.createRepo('/test/existing-repo');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  // -------------------------------------------------------------------------
  // ensureRemote
  // -------------------------------------------------------------------------

  describe('ensureRemote', () => {
    it('should return existing remote URL if one exists', async () => {
      // getRemoteUrl: git remote get-url origin
      mockCrossSpawn.mockResolvedValueOnce(
        mockSpawnSuccess('https://github.com/user/existing-repo.git'),
      );

      const result = await GitHubService.ensureRemote('/test/project');
      expect(result.success).toBe(true);
      expect(result.repoUrl).toBe('https://github.com/user/existing-repo.git');
    });

    it('should create repo if no remote exists', async () => {
      // getRemoteUrl fails (no remote)
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure('fatal: No such remote'));
      // isGhCliAvailable
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      // checkGhInstalled
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess());
      // gh repo create
      mockCrossSpawn.mockResolvedValueOnce(
        mockSpawnSuccess('https://github.com/user/new-repo'),
      );

      const result = await GitHubService.ensureRemote('/test/project');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getRemoteUrl / getCurrentBranch
  // -------------------------------------------------------------------------

  describe('getRemoteUrl', () => {
    it('should return remote URL on success', async () => {
      mockCrossSpawn.mockResolvedValueOnce(
        mockSpawnSuccess('https://github.com/user/repo.git'),
      );
      const url = await GitHubService.getRemoteUrl('/test');
      expect(url).toBe('https://github.com/user/repo.git');
    });

    it('should return null when no remote exists', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnFailure());
      const url = await GitHubService.getRemoteUrl('/test');
      expect(url).toBeNull();
    });
  });

  describe('getCurrentBranch', () => {
    it('should return branch name', async () => {
      mockCrossSpawn.mockResolvedValueOnce(mockSpawnSuccess('feature-branch'));
      const branch = await GitHubService.getCurrentBranch('/test');
      expect(branch).toBe('feature-branch');
    });

    it('should return null on failure', async () => {
      mockCrossSpawn.mockRejectedValueOnce(new Error('not a repo'));
      const branch = await GitHubService.getCurrentBranch('/test');
      expect(branch).toBeNull();
    });
  });
});
