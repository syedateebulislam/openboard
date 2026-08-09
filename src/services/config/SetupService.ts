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
import type { LLMConfig, LLMEffort } from '../../types/llm.js';
import { LLM_EFFORTS, LLM_PROVIDER_NAMES, defaultModelFor, isValidEffort } from '../../config/llmCatalog.js';
import {
  APP_MODE_IDS,
  allowedProvidersForMode,
  deployModeSuggestion,
  describeAppMode,
  getAppMode,
  isValidAppMode,
  modeAllowsDeploy,
  providerAllowedInMode,
  providerModeMismatchMessage,
  type AppMode,
} from '../../config/appModes.js';
import type { AgentErrorCode } from '../../utils/errorCodes.js';
import { TypedConfigRepository } from './TypedConfigRepository.js';
import { normalizeUserPath } from '../../utils/pathNormalizer.js';
import { discoverBillers, validateScriptsDir } from '../billers/BillerDiscoveryService.js';

export type ProgressFn = (line: string) => void;

/** Providers OpenBoard's setup supports (subset of the LLMConfig union). */
const PROVIDERS = LLM_PROVIDER_NAMES;
type SetupProvider = LLMConfig['provider'];

export interface SetupPartResult {
  configured: boolean;
  detail?: string;
  error?: string;
  errorCode?: AgentErrorCode;
}

export interface SetupStatus {
  /** Privacy mode: local (Ollama/LM Studio + preview), hybrid (cloud LLM + preview), remote (full pipeline). */
  mode: AppMode;
  modeDescription: string;
  llm: { provider: string; model?: string; effort?: string } | null;
  github: { username?: string } | null;
  vercel: boolean;
  dashboardAuth: boolean;
  billers: { email?: string; scriptsDir?: string; enabled: string[]; ready: boolean } | null;
}

export interface ConfigureBillersInput {
  scriptsDir?: string;
  email?: string;
  appPassword?: string;
  syncIntervalMinutes?: number;
  sinceDays?: number;
  /** Keys to switch on; replaces the current selection when provided. */
  enable?: string[];
}

export interface ConfigureLLMInput {
  provider?: string;
  model?: string;
  /** Execution effort: low | medium | high | max (default medium). */
  effort?: string;
  apiKey?: string;
  ollamaHost?: string;
  /** OpenAI-compatible base URL, primarily for a local LM Studio server. */
  baseUrl?: string;
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

  /**
   * Set the app mode — the privacy contract picked before everything else:
   * local (Ollama/LM Studio + local preview), hybrid (cloud LLM + local preview),
   * remote (cloud LLM + GitHub + live Vercel app).
   */
  configureMode(mode?: string): SetupPartResult {
    const trimmed = mode?.trim().toLowerCase();
    if (!isValidAppMode(trimmed)) {
      return {
        configured: false,
        error: `Invalid or missing --mode. Use one of: ${APP_MODE_IDS.join(', ')}.`,
        errorCode: 'E_VALIDATION',
      };
    }

    this.config.set('app.mode', trimmed);
    const notes: string[] = [describeAppMode(trimmed)];

    const provider = this.config.get('llm.provider') as string | undefined;
    if (provider && !providerAllowedInMode(provider, trimmed)) {
      const allowed = allowedProvidersForMode(trimmed).map((p) => `\`${p}\``).join(' or ');
      notes.push(`Warning: configured LLM provider "${provider}" is not allowed in this mode — choose ${allowed}.`);
    }
    return { configured: true, detail: `Mode set to ${trimmed} (${notes.join(' ')})` };
  }

  async configureLLM(input: ConfigureLLMInput): Promise<SetupPartResult> {
    const provider = input.provider?.trim() as SetupProvider | undefined;
    if (!provider || !(PROVIDERS as string[]).includes(provider)) {
      return { configured: false, error: `Invalid or missing --provider. Use one of: ${PROVIDERS.join(', ')}.`, errorCode: 'E_VALIDATION' };
    }

    const mode = getAppMode(this.config);
    if (!providerAllowedInMode(provider, mode)) {
      return {
        configured: false,
        error: providerModeMismatchMessage(provider, mode),
        errorCode: 'E_VALIDATION',
      };
    }
    const model = input.model?.trim() || defaultModelFor(provider);
    const effortInput = input.effort?.trim().toLowerCase();
    if (effortInput && !isValidEffort(effortInput)) {
      return { configured: false, error: `Invalid --effort "${effortInput}". Use one of: ${LLM_EFFORTS.join(', ')}.`, errorCode: 'E_VALIDATION' };
    }
    const effort = effortInput as LLMEffort | undefined;
    const apiKey = input.apiKey?.trim();
    const ollamaHost = input.ollamaHost?.trim();
    const baseUrl = input.baseUrl?.trim();

    if (provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'openai-codex' && !apiKey) {
      return { configured: false, error: `An API key is required for provider "${provider}".`, errorCode: 'E_VALIDATION' };
    }

    const llmConfig: LLMConfig = {
      provider,
      model,
      apiKey: apiKey || undefined,
      ollamaHost: ollamaHost || undefined,
      baseUrl: baseUrl || undefined,
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
      if (effort) this.config.set('llm.effort', effort);
      return { configured: true, detail: `LLM set to openai-codex (${model}${effort ? `, effort: ${effort}` : ''}).` };
    }

    const validation = await this.deps.validateLLM(llmConfig);
    if (!validation.valid) {
      return { configured: false, error: validation.error ?? 'LLM validation failed.', errorCode: 'E_LLM_FAILED' };
    }

    this.config.set('llm.provider', provider);
    this.config.set('llm.model', model);
    if (effort) this.config.set('llm.effort', effort);
    if (provider === 'ollama' && ollamaHost) {
      this.config.set('llm.ollamaHost', ollamaHost);
    } else if (provider === 'lmstudio') {
      this.config.set('llm.baseUrl', baseUrl || 'http://127.0.0.1:1234/v1');
    } else if (apiKey) {
      this.config.setEncrypted('llm.apiKey', apiKey);
    }
    return { configured: true, detail: `LLM set to ${provider} (${model}${effort ? `, effort: ${effort}` : ''}).` };
  }

  async configureGitHub(token?: string): Promise<SetupPartResult> {
    const mode = getAppMode(this.config);
    if (!modeAllowsDeploy(mode)) {
      return {
        configured: false,
        error: `GitHub is not used in ${mode} mode (${describeAppMode(mode)}). Switch first: openboard agent setup mode --mode ${deployModeSuggestion(mode).id}.`,
        errorCode: 'E_VALIDATION',
      };
    }
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
    const mode = getAppMode(this.config);
    if (!modeAllowsDeploy(mode)) {
      return {
        configured: false,
        error: `Vercel is not used in ${mode} mode (${describeAppMode(mode)}). Switch first: openboard agent setup mode --mode ${deployModeSuggestion(mode).id}.`,
        errorCode: 'E_VALIDATION',
      };
    }
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

  /**
   * Save invoice-fetcher settings. Unlike Gmail OAuth there is no interactive
   * step here, so a headless call can fully configure the feature — though the
   * recurring schedule itself only runs while the TUI is open.
   */
  configureBillers(input: ConfigureBillersInput): SetupPartResult {
    const scriptsDir = input.scriptsDir?.trim();
    const email = input.email?.trim();
    const appPassword = input.appPassword?.replace(/\s+/g, '');

    if (scriptsDir) {
      const path = normalizeUserPath(scriptsDir);
      const check = validateScriptsDir(path);
      if (!check.valid) {
        return { configured: false, error: check.error ?? 'Invalid --scripts-dir.', errorCode: 'E_VALIDATION' };
      }
      this.config.set('billers.scriptsDir', path);
    }

    if (email) {
      if (!email.includes('@')) {
        return { configured: false, error: 'Invalid --biller-email: expected a full address.', errorCode: 'E_VALIDATION' };
      }
      this.config.set('billers.email', email);
    }

    if (appPassword) {
      if (appPassword.length < 16) {
        return { configured: false, error: 'Invalid --biller-app-password: a Google App Password is 16 characters.', errorCode: 'E_VALIDATION' };
      }
      this.config.setEncrypted('billers.appPassword', appPassword);
    }

    if (input.syncIntervalMinutes !== undefined) {
      if (!Number.isInteger(input.syncIntervalMinutes) || input.syncIntervalMinutes < 1) {
        return { configured: false, error: 'Invalid --biller-sync-interval: whole minutes, minimum 1.', errorCode: 'E_VALIDATION' };
      }
      this.config.set('billers.syncIntervalMinutes', input.syncIntervalMinutes);
    }

    if (input.sinceDays !== undefined) {
      if (!Number.isInteger(input.sinceDays) || input.sinceDays < 1) {
        return { configured: false, error: 'Invalid --biller-since-days: whole days, minimum 1.', errorCode: 'E_VALIDATION' };
      }
      this.config.set('billers.sinceDays', input.sinceDays);
    }

    if (input.enable) {
      const dir = this.config.get('billers.scriptsDir') as string | undefined;
      const known = new Set(discoverBillers(dir).map((biller) => biller.key));
      const unknown = input.enable.filter((key) => !known.has(key));
      if (unknown.length > 0) {
        return {
          configured: false,
          error: `Unknown biller key(s): ${unknown.join(', ')}. Known: ${[...known].join(', ') || 'none — set --scripts-dir first'}.`,
          errorCode: 'E_VALIDATION',
        };
      }
      this.config.set('billers.enabledKeys', input.enable);
    }

    if (!scriptsDir && !email && !appPassword && !input.enable
      && input.syncIntervalMinutes === undefined && input.sinceDays === undefined) {
      return {
        configured: false,
        error: 'Nothing to configure. Pass --scripts-dir, --biller-email, --biller-app-password, --biller-key, --biller-sync-interval, or --biller-since-days.',
        errorCode: 'E_VALIDATION',
      };
    }

    const settings = new TypedConfigRepository(this.config).getBillerSettings();
    const ready = Boolean(settings.scriptsDir && settings.email && settings.appPassword);
    return {
      configured: true,
      detail: ready
        ? `Invoice fetchers ready — ${settings.enabledKeys.length} biller(s) enabled, every ${settings.syncIntervalMinutes} min while the TUI is open. Run \`openboard agent billers sync\` for a one-shot fetch.`
        : 'Invoice fetcher settings saved. Still needed: ' + [
            settings.scriptsDir ? null : 'scripts folder',
            settings.email ? null : 'Gmail address',
            settings.appPassword ? null : 'App Password',
          ].filter(Boolean).join(', ') + '.',
    };
  }

  status(): SetupStatus {
    const provider = this.config.get('llm.provider') as string | undefined;
    const githubUser = this.config.get('github.username') as string | undefined;
    const hasGithub = githubUser !== undefined || this.config.has('github.token');
    const mode = getAppMode(this.config);
    const effort = this.config.get('llm.effort') as string | undefined;
    return {
      mode,
      modeDescription: describeAppMode(mode),
      llm: provider
        ? {
            provider,
            model: this.config.get('llm.model') as string | undefined,
            ...(effort ? { effort } : {}),
          }
        : null,
      github: hasGithub ? { username: githubUser } : null,
      vercel: this.config.has('vercel.token'),
      dashboardAuth: Boolean(this.config.get('credentials.username')) && this.config.has('credentials.passwordHash'),
      billers: this.config.has('billers.scriptsDir')
        ? (() => {
            const billers = new TypedConfigRepository(this.config).getBillerSettings();
            return {
              email: billers.email,
              scriptsDir: billers.scriptsDir,
              enabled: billers.enabledKeys,
              ready: Boolean(billers.scriptsDir && billers.email && billers.appPassword),
            };
          })()
        : null,
    };
  }
}

export default SetupService;
