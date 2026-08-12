import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { crossSpawn, IS_WINDOWS, IS_MAC } from '../../utils/crossSpawn.js';
import type { ProgressCallback } from '../build/BuildService.js';

export interface GitHubResult {
  success: boolean;
  error?: string;
  commitHash?: string;
  pushed?: boolean;
  repoUrl?: string;
}

function runGitCommand(
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  onProgress?: ProgressCallback,
  useShell?: boolean,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return crossSpawn('git', args, { cwd, timeoutMs, onProgress, useShell, signal });
}

function isValidCommitEmail(email: string | undefined): email is string {
  const trimmed = email?.trim();
  if (!trimmed) return false;
  if (trimmed === 'openboard@local') return false;
  if (trimmed.endsWith('.local')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

async function getGitConfig(projectDir: string, key: string): Promise<string | undefined> {
  try {
    const { code, stdout } = await runGitCommand(['config', '--get', key], projectDir, 5_000);
    if (code !== 0) return undefined;
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getSavedGitHubToken(): Promise<string | undefined> {
  try {
    const { ConfigService } = await import('../config/ConfigService.js');
    const cfg = new ConfigService();
    try {
      return cfg.getDecrypted('github.token');
    } catch {
      const token = cfg.get('github.token');
      return typeof token === 'string' && !token.startsWith('enc:') ? token : undefined;
    }
  } catch {
    return undefined;
  }
}

async function getSavedGitHubUsername(): Promise<string | undefined> {
  try {
    const { ConfigService } = await import('../config/ConfigService.js');
    const username = new ConfigService().get('github.username');
    return typeof username === 'string' && username.trim() ? username.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function getGitHubIdentityFromToken(): Promise<{ login: string; email: string } | undefined> {
  const token = await getSavedGitHubToken();
  if (!token || typeof fetch !== 'function') return undefined;

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'OpenBoardCLI-TUI',
      },
    });
    if (!response.ok) return undefined;

    const data = await response.json() as { login?: string; id?: number; email?: string | null; name?: string | null };
    if (!data.login) return undefined;

    const publicEmail = data.email ?? undefined;
    return {
      login: data.name?.trim() || data.login,
      email: isValidCommitEmail(publicEmail)
        ? publicEmail
        : data.id
          ? `${data.id}+${data.login}@users.noreply.github.com`
          : `${data.login}@users.noreply.github.com`,
    };
  } catch {
    return undefined;
  }
}

export class GitHubService {
  static async checkGitInstalled(): Promise<boolean> {
    try {
      const { code } = await runGitCommand(['--version'], process.cwd());
      return code === 0;
    } catch {
      return false;
    }
  }

  static async isGitRepo(projectDir: string): Promise<boolean> {
    return existsSync(join(projectDir, '.git'));
  }

  static async initRepo(projectDir: string): Promise<GitHubResult> {
    try {
      const { code, stderr } = await runGitCommand(['init'], projectDir);
      if (code !== 0) return { success: false, error: stderr };
      await GitHubService.ensureProtectedDataExcluded(projectDir);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Raw dashboard rows (api/_data/*.json, api/_data/protected-data.ts) must
   * never enter Git history: GitHub repo readers, forks, and old commits would
   * expose them even though the deployed HTTP endpoint is authenticated.
   *
   * Exclusion is written to .git/info/exclude — NOT .gitignore — so the
   * Vercel CLI (which honors .gitignore when packaging uploads) still ships
   * the data files to the deployment. Already-tracked data files from older
   * projects are untracked (git rm --cached); the working-tree copies stay.
   */
  static async ensureProtectedDataExcluded(projectDir: string): Promise<void> {
    const patterns = ['api/_data/*.json', 'api/_data/protected-data.ts'];
    try {
      const excludePath = join(projectDir, '.git', 'info', 'exclude');
      if (!existsSync(join(projectDir, '.git'))) return;
      mkdirSync(dirname(excludePath), { recursive: true });

      let existing = '';
      try {
        existing = readFileSync(excludePath, 'utf-8');
      } catch {
        existing = '';
      }
      const missing = patterns.filter(pattern => !existing.split(/\r?\n/).includes(pattern));
      if (missing.length > 0) {
        const block = [
          '# OpenBoardCLI: raw dashboard data is deployed via Vercel CLI upload but never pushed to GitHub.',
          ...missing,
        ].join('\n');
        const next = existing.length > 0 && !existing.endsWith('\n')
          ? `${existing}\n${block}\n`
          : `${existing}${block}\n`;
        writeFileSync(excludePath, next, 'utf-8');
      }

      // Untrack data files that were committed before this exclusion existed.
      const tracked = await runGitCommand(['ls-files', '--', 'api/_data'], projectDir, 10_000);
      if (tracked.code === 0 && tracked.stdout.trim()) {
        const files = tracked.stdout
          .trim()
          .split('\n')
          .map(line => line.trim())
          .filter(file => file.endsWith('.json') || file.endsWith('protected-data.ts'));
        if (files.length > 0) {
          await runGitCommand(['rm', '--cached', '-q', '--', ...files], projectDir, 15_000);
        }
      }
    } catch {
      // Best-effort: a failure here must not block commit/push flows.
    }
  }

  static async ensureCommitAuthor(projectDir: string, onProgress?: ProgressCallback): Promise<GitHubResult> {
    const configuredEmail = await getGitConfig(projectDir, 'user.email');
    const configuredName = await getGitConfig(projectDir, 'user.name');
    if (isValidCommitEmail(configuredEmail)) {
      return { success: true };
    }

    const githubIdentity = await getGitHubIdentityFromToken();
    const savedUsername = await getSavedGitHubUsername();
    const author = githubIdentity ?? (
      savedUsername
        ? { login: savedUsername, email: `${savedUsername}@users.noreply.github.com` }
        : undefined
    );

    if (!author) {
      return {
        success: false,
        error: [
          'Git commit email is not configured.',
          'Set a valid Git email with `git config --global user.email "you@example.com"` or save a GitHub token in OpenBoardCLI Settings.',
        ].join(' '),
      };
    }

    // Both spellings are our own placeholder, never a real author: `OpenBoard`
    // is what older versions wrote into git config, so it still has to be
    // recognised or those repos keep committing under the placeholder.
    const isPlaceholderName = configuredName === 'OpenBoardCLI' || configuredName === 'OpenBoard';
    const name = configuredName && !isPlaceholderName ? configuredName : author.login;
    let result = await runGitCommand(['config', 'user.name', name], projectDir, 5_000);
    if (result.code !== 0) return { success: false, error: result.stderr || result.stdout };

    result = await runGitCommand(['config', 'user.email', author.email], projectDir, 5_000);
    if (result.code !== 0) return { success: false, error: result.stderr || result.stdout };

    onProgress?.(`Configured git author as ${name} <${author.email}>`);
    return { success: true };
  }

  static async addRemote(projectDir: string, remoteUrl: string): Promise<GitHubResult> {
    try {
      const { stdout } = await runGitCommand(['remote', 'get-url', 'origin'], projectDir);
      if (stdout.trim()) {
        const { code, stderr } = await runGitCommand(['remote', 'set-url', 'origin', remoteUrl], projectDir);
        if (code !== 0) return { success: false, error: stderr };
      } else {
        const { code, stderr } = await runGitCommand(['remote', 'add', 'origin', remoteUrl], projectDir);
        if (code !== 0) return { success: false, error: stderr };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async commit(projectDir: string, message: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<GitHubResult> {
    try {
      // Keep raw dashboard data out of Git before staging anything.
      await GitHubService.ensureProtectedDataExcluded(projectDir);

      // Add all files
      let result = await runGitCommand(['add', '.'], projectDir, 30_000, onProgress, undefined, signal);
      if (result.code !== 0) return { success: false, error: result.stderr };

      // Check if there are changes to commit
      const statusResult = await runGitCommand(['status', '--porcelain'], projectDir);
      if (!statusResult.stdout.trim()) {
        const repairResult = await GitHubService.repairInvalidHeadAuthor(projectDir, onProgress);
        if (repairResult.success) return repairResult;
        return { success: false, error: 'No changes to commit' };
      }

      const authorResult = await GitHubService.ensureCommitAuthor(projectDir, onProgress);
      if (!authorResult.success) return authorResult;

      // Commit — shell: false on ALL platforms to prevent arg splitting on special chars
      result = await runGitCommand(['commit', '-m', message], projectDir, 30_000, onProgress, false, signal);
      if (result.code !== 0) return { success: false, error: result.stderr };

      // Get commit hash
      const hashResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir);
      const commitHash = hashResult.stdout.trim();

      return { success: true, commitHash };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async repairInvalidHeadAuthor(projectDir: string, onProgress?: ProgressCallback): Promise<GitHubResult> {
    const headAuthor = await runGitCommand(['log', '-1', '--format=%ae'], projectDir, 10_000).catch(() => null);
    const email = headAuthor?.stdout.trim();
    if (headAuthor?.code !== 0 || isValidCommitEmail(email)) {
      return { success: false, error: 'No changes to commit' };
    }

    onProgress?.(`Current HEAD author email (${email}) is not deployable by Vercel. Creating a new metadata commit.`);
    const authorResult = await GitHubService.ensureCommitAuthor(projectDir, onProgress);
    if (!authorResult.success) return authorResult;

    const commitResult = await runGitCommand(
      ['commit', '--allow-empty', '-m', 'Fix OpenBoardCLI deployment author'],
      projectDir,
      30_000,
      onProgress,
      false,
    );
    if (commitResult.code !== 0) {
      return { success: false, error: commitResult.stderr || commitResult.stdout };
    }

    const hashResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir);
    return { success: true, commitHash: hashResult.stdout.trim() };
  }

  // The branch parameter is kept for API compatibility but the push always
  // targets the repo's current branch.
  static async push(projectDir: string, _branch = 'main', onProgress?: ProgressCallback, signal?: AbortSignal): Promise<GitHubResult> {
    try {
      const branchResult = await runGitCommand(['branch', '--show-current'], projectDir);
      const currentBranch = branchResult.stdout.trim() || 'main';

      const { code, stderr, stdout } = await runGitCommand(
        ['push', '-u', 'origin', currentBranch],
        projectDir,
        60_000,
        onProgress,
        undefined,
        signal,
      );

      if (code !== 0) {
        return { success: false, error: stderr || stdout };
      }

      return { success: true, pushed: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async commitAndPush(
    projectDir: string,
    commitMessage: string,
    branch = 'main',
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<GitHubResult> {
    const commitResult = await GitHubService.commit(projectDir, commitMessage, onProgress, signal);
    if (!commitResult.success) return commitResult;

    // Ensure a GitHub remote exists before pushing
    const remoteResult = await GitHubService.ensureRemote(projectDir, onProgress, signal);
    if (!remoteResult.success) {
      return {
        success: false,
        error: remoteResult.error,
        commitHash: commitResult.commitHash,
      };
    }

    // If ensureRemote already pushed (via gh repo create --push), we're done
    if (remoteResult.pushed) {
      return {
        success: true,
        commitHash: commitResult.commitHash,
        pushed: true,
        repoUrl: remoteResult.repoUrl,
      };
    }

    const pushResult = await GitHubService.push(projectDir, branch, onProgress, signal);
    return {
      success: pushResult.success,
      error: pushResult.error,
      commitHash: commitResult.commitHash,
      pushed: pushResult.pushed,
    };
  }

  /**
   * Check if the `gh` binary exists on PATH.
   */
  static async isGhCliAvailable(): Promise<boolean> {
    try {
      const { code } = await crossSpawn('gh', ['--version'], { cwd: process.cwd(), timeoutMs: 5_000 });
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if the GitHub CLI (gh) is installed and authenticated.
   */
  static async checkGhInstalled(): Promise<boolean> {
    try {
      const { code } = await crossSpawn('gh', ['auth', 'status'], { cwd: process.cwd(), timeoutMs: 10_000 });
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * The exact commands autoInstallGhCli would run on this platform.
   *
   * Exists so a caller can show the user what they are agreeing to before
   * anything runs. On Linux that list includes `sudo` and a permanent change
   * to the machine's APT sources, which nobody should discover after the fact.
   */
  static describeGhInstallPlan(): { requiresRoot: boolean; commands: string[] } {
    if (IS_WINDOWS) {
      return {
        requiresRoot: false,
        commands: ['winget install --id GitHub.cli -e'],
      };
    }
    if (IS_MAC) {
      return { requiresRoot: false, commands: ['brew install gh'] };
    }
    return {
      requiresRoot: true,
      commands: [
        'sudo mkdir -p /etc/apt/keyrings',
        'sudo curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg',
        'sudo tee /etc/apt/sources.list.d/github-cli.list  (adds the GitHub CLI APT repository)',
        'sudo apt update && sudo apt install -y gh',
        'or, on non-apt systems: sudo dnf install -y gh',
      ],
    };
  }

  /**
   * Install the GitHub CLI. Uses winget on Windows, brew on macOS, apt/dnf on
   * Linux.
   *
   * `consent` is required and has no default. On Linux this adds a third-party
   * APT repository and signing key to the user's system as root — a permanent
   * machine change, made by a tool they ran to build a dashboard. Pair it with
   * describeGhInstallPlan() so the user sees the commands first, and treat
   * "install gh yourself" as an equally valid answer.
   */
  static async autoInstallGhCli(
    options: { consent: boolean; onProgress?: ProgressCallback },
  ): Promise<boolean> {
    const { consent, onProgress } = options;
    const available = await GitHubService.isGhCliAvailable();
    if (available) return true;

    if (!consent) {
      onProgress?.('GitHub CLI (gh) is not installed. Install it and re-run, or approve the install when prompted.');
      return false;
    }

    onProgress?.('📥 GitHub CLI (gh) not found. Installing with your approval...');

    try {
      let cmd: string;
      let args: string[];

      if (IS_WINDOWS) {
        cmd = 'winget';
        args = ['install', '--id', 'GitHub.cli', '-e', '--accept-source-agreements', '--accept-package-agreements'];
      } else if (IS_MAC) {
        cmd = 'brew';
        args = ['install', 'gh'];
      } else {
        // Linux — try apt first, fall back to dnf
        const { code: aptCode } = await crossSpawn('which', ['apt'], { cwd: process.cwd(), timeoutMs: 5_000 }).catch(() => ({ code: 1 }));
        if (aptCode === 0) {
          // No `bash -c` here. These were the only shell-mediated commands in
          // the codebase, and the pipes they existed for are avoidable: curl
          // can write the keyring itself, and the architecture that used to
          // come from $(dpkg --print-architecture) can be read first and
          // interpolated. Everything below reaches the OS as argv.
          await crossSpawn('sudo', ['mkdir', '-p', '/etc/apt/keyrings'], { cwd: process.cwd(), timeoutMs: 10_000, onProgress });
          await crossSpawn('sudo', [
            'curl', '-fsSL',
            'https://cli.github.com/packages/githubcli-archive-keyring.gpg',
            '-o', '/etc/apt/keyrings/githubcli-archive-keyring.gpg',
          ], { cwd: process.cwd(), timeoutMs: 30_000, onProgress });

          const { stdout: arch } = await crossSpawn('dpkg', ['--print-architecture'], {
            cwd: process.cwd(),
            timeoutMs: 10_000,
          }).catch(() => ({ stdout: '' }));
          const sourceLine =
            `deb [arch=${arch.trim() || 'amd64'} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg]` +
            ' https://cli.github.com/packages stable main\n';
          // tee reads the line from stdin rather than a shell echo.
          await crossSpawn('sudo', ['tee', '/etc/apt/sources.list.d/github-cli.list'], {
            cwd: process.cwd(),
            timeoutMs: 10_000,
            stdin: sourceLine,
          });

          await crossSpawn('sudo', ['apt', 'update'], { cwd: process.cwd(), timeoutMs: 60_000, onProgress });
          cmd = 'sudo';
          args = ['apt', 'install', '-y', 'gh'];
        } else {
          cmd = 'sudo';
          args = ['dnf', 'install', '-y', 'gh'];
        }
      }

      onProgress?.(`Running: ${cmd} ${args.join(' ')}`);
      const { code, stderr } = await crossSpawn(cmd, args, { cwd: process.cwd(), timeoutMs: 120_000, onProgress });

      if (code !== 0) {
        onProgress?.(`Failed to install gh CLI: ${stderr}`);
        return false;
      }

      // Verify installation
      const installed = await GitHubService.isGhCliAvailable();
      if (installed) {
        onProgress?.('GitHub CLI installed successfully');
      } else {
        onProgress?.('gh CLI installed but not found on PATH. You may need to restart your terminal.');
      }
      return installed;
    } catch (error: any) {
      onProgress?.(`Auto-install failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Authenticate gh CLI using a GitHub Personal Access Token.
   * Pipes the token to `gh auth login --with-token`.
   */
  static async loginWithToken(token: string, onProgress?: ProgressCallback): Promise<boolean> {
    const available = await GitHubService.isGhCliAvailable();
    if (!available) {
      onProgress?.('gh CLI not available, skipping auth setup');
      return false;
    }

      onProgress?.('Authenticating gh CLI with token...');
    try {
      const result = await crossSpawn('gh', ['auth', 'login', '--with-token'], {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        stdin: token,
      });
      if (result.code === 0) {
        onProgress?.('gh CLI authenticated successfully');
        return true;
      }
      onProgress?.(`gh auth failed: ${result.stderr.trim()}`);
      return false;
    } catch (error: any) {
      onProgress?.(`gh auth error: ${error.message}`);
      return false;
    }
  }

  /**
   * Ensure gh CLI is installed and authenticated. Does not auto-install package managers.
   */
  static async ensureGhCli(onProgress?: ProgressCallback): Promise<{ installed: boolean; authenticated: boolean }> {
    const available = await GitHubService.isGhCliAvailable();
    if (!available) {
      onProgress?.('GitHub CLI (gh) is not installed. Install it manually from https://cli.github.com and run setup again.');
      return { installed: false, authenticated: false };
    }

    // Step 2: Check authentication
    let authenticated = await GitHubService.checkGhInstalled();
    if (!authenticated) {
      // Try auto-login with saved token from config
      try {
        const { ConfigService } = await import('../config/ConfigService.js');
        const cfg = new ConfigService();
        let savedToken: string | undefined;
        try {
          savedToken = cfg.getDecrypted('github.token');
        } catch {
          savedToken = cfg.get('github.token') as string | undefined;
        }
        if (savedToken) {
          onProgress?.('Found saved GitHub token, authenticating gh CLI...');
          const loginOk = await GitHubService.loginWithToken(savedToken, onProgress);
          if (loginOk) {
            authenticated = true;
          }
        }
      } catch {
        // Config not available — skip auto-login
      }

      if (!authenticated) {
        onProgress?.('gh CLI is not authenticated. Run setup wizard or: gh auth login');
      }
    }
    return { installed: true, authenticated };
  }

  /**
   * Create a GitHub repo using the `gh` CLI and set it as origin.
   * Uses the project folder name as the repo name.
   * Auto-installs gh CLI if not available.
   */
  static async createRepo(
    projectDir: string,
    visibility: 'public' | 'private' = 'private',
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<GitHubResult> {
    try {
      const { installed, authenticated } = await GitHubService.ensureGhCli(onProgress);
      if (!installed) {
        return {
          success: false,
          error: 'GitHub CLI (gh) could not be installed automatically. Install it manually from https://cli.github.com',
        };
      }
      if (!authenticated) {
        return {
          success: false,
          error: 'GitHub CLI is not authenticated. Run: gh auth login',
        };
      }

      const repoName = basename(projectDir);
      onProgress?.(`Creating GitHub repo: ${repoName} (${visibility})...`);

      const { code, stderr, stdout } = await crossSpawn(
        'gh',
        ['repo', 'create', repoName, `--${visibility}`, '--source=.', '--remote=origin', '--push'],
        { cwd: projectDir, timeoutMs: 60_000, onProgress, signal },
      );

      if (code !== 0) {
        return { success: false, error: stderr || stdout };
      }

      // Extract repo URL from output
      const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
      const repoUrl = urlMatch ? urlMatch[0] : undefined;

      return { success: true, pushed: true, repoUrl };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Ensure a remote origin exists. If not, auto-create a GitHub repo via `gh`.
   */
  static async ensureRemote(
    projectDir: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<GitHubResult> {
    const existingRemote = await GitHubService.getRemoteUrl(projectDir);
    if (existingRemote) {
      return { success: true, repoUrl: existingRemote };
    }

    // No remote — try to create one via gh CLI
    onProgress?.('No GitHub remote found. Creating repository...');
    return GitHubService.createRepo(projectDir, 'private', onProgress, signal);
  }

  static async getRemoteUrl(projectDir: string): Promise<string | null> {
    try {
      const { stdout, code } = await runGitCommand(['remote', 'get-url', 'origin'], projectDir);
      if (code !== 0) return null;
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  static async getCurrentBranch(projectDir: string): Promise<string | null> {
    try {
      const { stdout, code } = await runGitCommand(['branch', '--show-current'], projectDir);
      if (code !== 0) return null;
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
