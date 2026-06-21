/**
 * SetupService — non-interactive OpenBoard configuration.
 *
 * Mirrors the TUI setup wizard so an automation agent can configure OpenBoard
 * (LLM provider, GitHub token, Vercel token, dashboard login) without opening
 * the interactive UI. Each credential is validated before it is saved, and
 * secrets are stored encrypted exactly as the TUI stores them.
 *
 * Network/CLI side effects are injectable (SetupDeps) so the logic is unit
 * testable without hitting GitHub/Vercel/the LLM provider.
 */

import { ConfigService } from './ConfigService.js';
import { LLMService } from '../llm/LLMService.js';
import { OpenAICodexProvider } from '../llm/OpenAICodexProvider.js';
import { GitHubService } from '../deploy/GitHubService.js';
import { VercelService } from '../deploy/VercelService.js';
import { AuthService } from '../auth/AuthService.js';
import type { LLMConfig } from '../../types/llm.js';
import type { AgentErrorCode } from '../../utils/errorCodes.js';

export type ProgressFn = (line: string) => void;

/** Providers OpenBoard's setup supports (subset of the LLMConfig union). */
const PROVIDERS = ['openai', 'openai-codex', 'anthropic', 'moonshot', 'ollama'] as const;
type SetupProvider = (typeof PROVIDERS)[number];

const DEFAULT_MODELS: Record<SetupProvider, string> = {
  openai: 'gpt-4o',
  'openai-codex': 'gpt-5.5',
  anthropic: 'claude-sonnet-4-5',
  moonshot: 'moonshot-v1-8k',
  ollama: 'qwen2.5-coder:7b',
};

export interface SetupPartResult {
  configured: boolean;
  detail?: string;
  error?: string;
  errorCode?: AgentErrorCode;
}

export interface SetupStatus {
  llm: { provider: string; model?: string } | null;
  github: { username?: string } | null;
  vercel: boolean;
  dashboardAuth: boolean;
}

export interface ConfigureLLMInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  ollamaHost?: string;
  /** ChatGPT/Codex access token for a fully-headless `openai-codex` sign-in. */
  codexAccessToken?: string;
  /** Streams login progress (e.g. the device-auth URL/code) so agents can relay it. */
  onProgress?: ProgressFn;
}

/** How codex should sign in when not already authenticated. */
export interface CodexLoginInput {
  accessToken?: string;
  apiKey?: string;
  onProgress?: ProgressFn;
}

/** Side effects that hit the network / a CLI — injectable for tests. */
export interface SetupDeps {
  validateLLM(config: LLMConfig): Promise<{ valid: boolean; error?: string }>;
  validateGitHubToken(token: string): Promise<{ login?: string; error?: string }>;
  ghLogin(token: string): Promise<void>;
  validateVercelToken(token: string): Promise<{ success: boolean; error?: string }>;
  /**
   * Sign codex in (OpenBoard's isolated codex home) when not already logged in:
   * an access token or API key is fully headless; otherwise device-auth streams
   * a URL/code via onProgress.
   */
  codexLogin(input: CodexLoginInput): Promise<{ valid: boolean; error?: string }>;
}

const defaultDeps: SetupDeps = {
  validateLLM: (config) => LLMService.createProvider(config).validate(),
  validateGitHubToken: async (token) => {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'OpenBoard-CLI', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `Invalid GitHub token (HTTP ${res.status}). ${body.slice(0, 160)}`.trim() };
      }
      const data = (await res.json()) as { login?: string };
      return { login: data.login };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'GitHub validation failed' };
    }
  },
  ghLogin: async (token) => {
    // Best-effort: prime the gh CLI session now. Pushes also auto-login lazily,
    // so failure here must not fail setup.
    await GitHubService.loginWithToken(token).catch(() => undefined);
  },
  validateVercelToken: (token) => VercelService.validateTokenForProjectAccess(token),
  codexLogin: (input) => {
    if (input.accessToken) return OpenAICodexProvider.loginWithAccessToken(input.accessToken, input.onProgress);
    if (input.apiKey) return OpenAICodexProvider.loginWithApiKey(input.apiKey, input.onProgress);
    return OpenAICodexProvider.loginWithDeviceAuth(input.onProgress);
  },
};

export class SetupService {
  private config: ConfigService;
  private deps: SetupDeps;

  constructor(config = new ConfigService(), deps: Partial<SetupDeps> = {}) {
    this.config = config;
    this.deps = { ...defaultDeps, ...deps };
  }

  async configureLLM(input: ConfigureLLMInput): Promise<SetupPartResult> {
    const provider = input.provider?.trim() as SetupProvider | undefined;
    if (!provider || !PROVIDERS.includes(provider)) {
      return { configured: false, error: `Invalid or missing --provider. Use one of: ${PROVIDERS.join(', ')}.`, errorCode: 'E_VALIDATION' };
    }
    const model = input.model?.trim() || DEFAULT_MODELS[provider];
    const apiKey = input.apiKey?.trim();
    const ollamaHost = input.ollamaHost?.trim();

    if (provider !== 'ollama' && provider !== 'openai-codex' && !apiKey) {
      return { configured: false, error: `An API key is required for provider "${provider}".`, errorCode: 'E_VALIDATION' };
    }

    const llmConfig: LLMConfig = {
      provider,
      model,
      apiKey: apiKey || undefined,
      ollamaHost: ollamaHost || undefined,
    };

    // Codex: if not already signed in, sign in headlessly (access token / API
    // key) or via device-auth (URL+code streamed through onProgress). The codex
    // CLI holds the auth in OpenBoard's isolated codex home — no key is stored.
    if (provider === 'openai-codex') {
      let validation = await this.deps.validateLLM(llmConfig);
      if (!validation.valid) {
        input.onProgress?.('OpenAI Codex is not signed in — starting login…');
        const login = await this.deps.codexLogin({
          accessToken: input.codexAccessToken,
          apiKey,
          onProgress: input.onProgress,
        });
        if (!login.valid) {
          return { configured: false, error: login.error ?? 'Codex login failed.', errorCode: 'E_LLM_FAILED' };
        }
        validation = { valid: true };
      }
      this.config.set('llm.provider', provider);
      this.config.set('llm.model', model);
      return { configured: true, detail: `LLM set to openai-codex (${model}).` };
    }

    const validation = await this.deps.validateLLM(llmConfig);
    if (!validation.valid) {
      return { configured: false, error: validation.error ?? 'LLM validation failed.', errorCode: 'E_LLM_FAILED' };
    }

    this.config.set('llm.provider', provider);
    this.config.set('llm.model', model);
    if (provider === 'ollama' && ollamaHost) {
      this.config.set('llm.ollamaHost', ollamaHost);
    } else if (apiKey) {
      this.config.setEncrypted('llm.apiKey', apiKey);
    }
    return { configured: true, detail: `LLM set to ${provider} (${model}).` };
  }

  async configureGitHub(token?: string): Promise<SetupPartResult> {
    const trimmed = token?.trim();
    if (!trimmed) {
      return { configured: false, error: 'Missing GitHub token (--github-token or OPENBOARD_GITHUB_TOKEN).', errorCode: 'E_VALIDATION' };
    }
    const result = await this.deps.validateGitHubToken(trimmed);
    if (!result.login) {
      return { configured: false, error: result.error ?? 'GitHub token validation failed.', errorCode: 'E_VALIDATION' };
    }
    this.config.setEncrypted('github.token', trimmed);
    this.config.set('github.username', result.login);
    await this.deps.ghLogin(trimmed);
    return { configured: true, detail: `GitHub token saved for ${result.login}.` };
  }

  async configureVercel(token?: string): Promise<SetupPartResult> {
    const trimmed = token?.trim();
    if (!trimmed) {
      return { configured: false, error: 'Missing Vercel token (--vercel-token or OPENBOARD_VERCEL_TOKEN).', errorCode: 'E_VALIDATION' };
    }
    const result = await this.deps.validateVercelToken(trimmed);
    if (!result.success) {
      return { configured: false, error: result.error ?? 'Vercel token validation failed.', errorCode: 'E_DEPLOY_AUTH' };
    }
    this.config.setEncrypted('vercel.token', trimmed);
    return { configured: true, detail: 'Vercel token saved.' };
  }

  async configureDashboardAuth(username?: string, password?: string): Promise<SetupPartResult> {
    const user = username?.trim();
    if (!user) {
      return { configured: false, error: 'Missing dashboard --username.', errorCode: 'E_VALIDATION' };
    }
    if (!password || password.length < 8) {
      return { configured: false, error: 'Dashboard password is required and must be at least 8 characters.', errorCode: 'E_VALIDATION' };
    }
    const creds = await AuthService.prepareCredentials(user, password);
    this.config.set('credentials.username', creds.username);
    this.config.setEncrypted('credentials.passwordHash', creds.passwordHash);
    this.config.setEncrypted('credentials.jwtSecret', creds.jwtSecret);
    return { configured: true, detail: `Dashboard login saved for "${user}".` };
  }

  status(): SetupStatus {
    const provider = this.config.get('llm.provider') as string | undefined;
    const githubUser = this.config.get('github.username') as string | undefined;
    const hasGithub = githubUser !== undefined || this.config.has('github.token');
    return {
      llm: provider ? { provider, model: this.config.get('llm.model') as string | undefined } : null,
      github: hasGithub ? { username: githubUser } : null,
      vercel: this.config.has('vercel.token'),
      dashboardAuth: Boolean(this.config.get('credentials.username')) && this.config.has('credentials.passwordHash'),
    };
  }
}

export default SetupService;
