/**
 * SetupWizard — 4-panel TUI setup wizard for OpenBoard initial configuration.
 *
 * Guides the user through:
 *  Step 1: LLM provider selection (OpenAI / Anthropic / Ollama) + API key + model
 *  Step 2: GitHub Personal Access Token (optional)
 *  Step 3: Vercel API token (optional)
 *  Step 4: Dashboard username + password → bcrypt hash + JWT secret
 *
 * Uses Ink for TUI rendering, ink-text-input for text fields.
 * Calls AuthService.prepareCredentials and saves to ConfigService on completion.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';

import { AuthService } from '../services/auth/AuthService.js';
import { LLMService } from '../services/llm/LLMService.js';
import { OpenAICodexProvider } from '../services/llm/OpenAICodexProvider.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { GitHubService } from '../services/deploy/GitHubService.js';
import { VercelService } from '../services/deploy/VercelService.js';
import type { LLMConfig } from '../types/llm.js';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WizardStep = 1 | 2 | 3 | 4;
type LLMProviderName = 'openai' | 'openai-codex' | 'anthropic' | 'ollama' | 'moonshot';

interface ValidationState {
  status: 'idle' | 'validating' | 'success' | 'error';
  message?: string;
}

interface WizardConfig {
  // Step 1
  llmProvider: LLMProviderName;
  llmApiKey: string;
  llmModel: string;
  ollamaHost: string;
  // Step 2
  githubToken: string;
  githubSkipped: boolean;
  // Step 3
  vercelToken: string;
  vercelSkipped: boolean;
  // Step 4
  username: string;
  password: string;
  passwordConfirm: string;
}

interface SetupWizardProps {
  onComplete: (config: WizardConfig) => void;
  onNavigate?: (screen: Screen) => void;
  configService?: ConfigService;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_PROVIDERS = [
  { label: 'OpenAI API Key (GPT-4o, GPT-4 Turbo)', value: 'openai' },
  { label: 'OpenAI Codex / ChatGPT subscription (browser login)', value: 'openai-codex' },
  { label: 'Anthropic (Claude Sonnet, Opus)', value: 'anthropic' },
  { label: 'Moonshot AI (Kimi 2.5, Kimi models)', value: 'moonshot' },
  { label: 'Ollama (Local, free)', value: 'ollama' },
  { label: '← Go Back', value: 'back' },
];

const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  openai: 'gpt-4o',
  'openai-codex': 'gpt-5.5',
  anthropic: 'claude-sonnet-4-5',
  moonshot: 'moonshot-v1-128k',
  ollama: 'qwen2.5-coder:7b',
};

const MODEL_CHOICES: Record<LLMProviderName, Array<{ label: string; value: string }>> = {
  openai: [
    { label: 'GPT-4o (Latest, 128K context)', value: 'gpt-4o' },
    { label: 'GPT-4 Turbo (Fast, 128K context)', value: 'gpt-4-turbo' },
    { label: 'GPT-3.5 Turbo (Cheap, 16K context)', value: 'gpt-3.5-turbo' },
  ],
  'openai-codex': [
    { label: 'GPT-5.5 (Codex recommended)', value: 'gpt-5.5' },
    { label: 'GPT-5.4 (Codex)', value: 'gpt-5.4' },
    { label: 'GPT-5.4 Mini (Codex, fast)', value: 'gpt-5.4-mini' },
    { label: 'GPT-5.3 Codex', value: 'gpt-5.3-codex' },
  ],
  anthropic: [
    { label: 'Claude Opus 4.5 (Most capable, 200K)', value: 'claude-opus-4-5' },
    { label: 'Claude Sonnet 4.5 (Balanced, 200K)', value: 'claude-sonnet-4-5' },
    { label: 'Claude Haiku 3.5 (Fast, 200K)', value: 'claude-haiku-3-5' },
  ],
  moonshot: [
    { label: 'Kimi v1-128k (128K context)', value: 'moonshot-v1-128k' },
    { label: 'Kimi v1-32k (32K context)', value: 'moonshot-v1-32k' },
    { label: 'Kimi v1-8k (8K context)', value: 'moonshot-v1-8k' },
  ],
  ollama: [
    // 🏆 Best for Code Generation
    { label: '🥇 Qwen2.5-Coder 7B (4.5GB) - Best code quality', value: 'qwen2.5-coder:7b' },
    { label: '🔥 DeepSeek-Coder-V2 16B (8.9GB) - Advanced coding', value: 'deepseek-coder-v2:16b' },
    { label: '💻 CodeLlama 13B (7.4GB) - Python/JS specialist', value: 'codellama:13b' },
    { label: '⚡ CodeLlama 7B (3.8GB) - Fast coding', value: 'codellama:7b' },
    { label: '🌏 Yi-Coder 9B (5.4GB) - Multilingual code', value: 'yi-coder:9b' },
    
    // 🎯 Best General Purpose
    { label: '🦙 Llama 3.1 8B (4.7GB) - Latest Meta model', value: 'llama3.1:8b' },
    { label: '🦙 Llama 3.2 3B (2GB) - Ultra compact', value: 'llama3.2:3b' },
    { label: '💎 Gemma2 9B (5.4GB) - Google\'s best', value: 'gemma2:9b' },
    { label: '🧠 Phi-3 Medium 14B (7.9GB) - Microsoft efficient', value: 'phi3:14b' },
    
    // ⚡ Best for Speed
    { label: '🚀 Mistral 7B (4.1GB) - Blazing fast', value: 'mistral:7b' },
    { label: '🏃 Phi-3 Mini (2.3GB) - Tiny powerhouse', value: 'phi3:mini' },
    { label: '⚡ Qwen2.5 7B (4.5GB) - Fast multilingual', value: 'qwen2.5:7b' },
  ],
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Progress indicator showing current step */
function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <Box marginBottom={1}>
      <Text bold color={UI_COLORS.logo}>
        Step {current}/{total}
      </Text>
      <Text color={UI_COLORS.subtitle}>
        {' '}
        {'█'.repeat(current)}
        {'░'.repeat(total - current)}
      </Text>
    </Box>
  );
}

/** Status badge for validation results */
function StatusBadge({ state }: { state: ValidationState }) {
  if (state.status === 'idle') return null;

  if (state.status === 'validating') {
    return (
      <Box marginTop={1}>
        <Text color="yellow">
          <Spinner type="dots" />
          {' Validating...'}
        </Text>
      </Box>
    );
  }

  if (state.status === 'success') {
    return (
      <Box marginTop={1}>
        <Text color="green">✓ {state.message ?? 'Valid'}</Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text color="red">✗ {state.message ?? 'Validation failed'}</Text>
    </Box>
  );
}

/** Section header */
function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="white">
        {title}
      </Text>
      {subtitle && <Text color={UI_COLORS.subtitle}>{subtitle}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 1: LLM Configuration
// ---------------------------------------------------------------------------

interface Step1Props {
  provider: LLMProviderName;
  apiKey: string;
  model: string;
  ollamaHost: string;
  validation: ValidationState;
  onProviderSelect: (p: LLMProviderName) => void;
  onApiKeyChange: (k: string) => void;
  onModelChange: (m: string) => void;
  onOllamaHostChange: (h: string) => void;
  onSubmit: () => void;
  onNavigate?: (screen: Screen) => void;
}

function Step1LLMConfig({
  provider,
  apiKey,
  model,
  ollamaHost,
  validation,
  onProviderSelect,
  onApiKeyChange,
  onModelChange,
  onOllamaHostChange,
  onSubmit,
  onNavigate,
}: Step1Props) {
  const [phase, setPhase] = useState<'provider' | 'key' | 'model' | 'host'>('provider');

  // Handle provider selection
  const handleProviderSelect = useCallback(
    (item: { value: string }) => {
      // Handle "Go Back" option
      if (item.value === 'back') {
        if (onNavigate) onNavigate('welcome');
        return;
      }
      
      const p = item.value as LLMProviderName;
      onProviderSelect(p);
      if (p === 'ollama') {
        setPhase('host');
      } else if (p === 'openai-codex') {
        setPhase('model');
      } else {
        setPhase('key');
      }
    },
    [onProviderSelect, onNavigate],
  );

  // Handle key submission → move to model
  const handleKeySubmit = useCallback(
    (value: string) => {
      if (value.trim().length > 0) {
        setPhase('model');
      }
    },
    [],
  );

  // Handle host submission → move to model
  const handleHostSubmit = useCallback(() => {
    setPhase('model');
  }, []);

  // Handle model submission → validate
  const handleModelSubmit = useCallback(
    (value: string) => {
      if (value.trim().length > 0) {
        onSubmit();
      }
    },
    [onSubmit],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="Step 1: LLM Provider"
        subtitle="Choose the AI provider for code generation"
      />

      {phase === 'provider' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Select your LLM provider:</Text>
          <Box marginTop={1}>
            <SelectInput items={LLM_PROVIDERS} onSelect={handleProviderSelect} />
          </Box>
        </Box>
      )}

      {phase === 'key' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Provider: {provider}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              {provider === 'openai' ? 'OpenAI' : 
               provider === 'anthropic' ? 'Anthropic' : 
               provider === 'moonshot' ? 'Moonshot AI' : 
               'API'} API Key:
            </Text>
            <TextInput
              value={apiKey}
              onChange={onApiKeyChange}
              onSubmit={handleKeySubmit}
              mask="*"
              placeholder={provider === 'moonshot' ? 'sk-...' : 'sk-...'}
            />
          </Box>
        </Box>
      )}

      {phase === 'host' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Provider: Ollama (Local)</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Ollama Host URL:</Text>
            <TextInput
              value={ollamaHost}
              onChange={onOllamaHostChange}
              onSubmit={handleHostSubmit}
              placeholder="http://127.0.0.1:11434"
            />
          </Box>
        </Box>
      )}

      {phase === 'model' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Provider: {provider}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={UI_COLORS.logo}>Select model:</Text>
            <Box marginTop={1}>
              <SelectInput 
                items={MODEL_CHOICES[provider]} 
                onSelect={(item) => {
                  onModelChange(item.value);
                  // Auto-submit after selection
                  setTimeout(() => {
                    onSubmit();
                  }, 150);
                }}
              />
            </Box>
          </Box>
          <Text color={UI_COLORS.subtitle}>
            Use ↑↓ arrows to select, Enter to validate
          </Text>
        </Box>
      )}

      <StatusBadge state={validation} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 2: GitHub PAT
// ---------------------------------------------------------------------------

interface Step2Props {
  token: string;
  validation: ValidationState;
  onTokenChange: (t: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onNavigate?: (screen: Screen) => void;
}

function Step2GitHub({ token, validation, onTokenChange, onSubmit, onSkip, onNavigate }: Step2Props) {
  const [mode, setMode] = useState<'menu' | 'input'>('menu');

  const menuItems = [
    { label: 'Enter GitHub Personal Access Token', value: 'enter' },
    { label: 'Skip for now', value: 'skip' },
    { label: '← Go Back', value: 'back' },
  ];

  const handleMenuSelect = useCallback(
    (item: { value: string }) => {
      if (item.value === 'skip') {
        onSkip();
      } else if (item.value === 'back') {
        if (onNavigate) onNavigate('welcome');
      } else {
        setMode('input');
      }
    },
    [onSkip, onNavigate],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="Step 2: GitHub Integration"
        subtitle="Optional: create a repo and push dashboard code to GitHub"
      />

      {mode === 'menu' && (
        <SelectInput items={menuItems} onSelect={handleMenuSelect} />
      )}

      {mode === 'input' && (
        <Box flexDirection="column">
          <Text>GitHub Personal Access Token (repo scope required):</Text>
          <Box marginTop={1}>
            <TextInput
              value={token}
              onChange={onTokenChange}
              onSubmit={onSubmit}
              mask="*"
              placeholder="ghp_..."
            />
          </Box>
          <Text color={UI_COLORS.subtitle}>
            Create at: github.com/settings/tokens (needs repo scope)
          </Text>
        </Box>
      )}

      <StatusBadge state={validation} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Vercel Token
// ---------------------------------------------------------------------------

interface Step3Props {
  token: string;
  validation: ValidationState;
  onTokenChange: (t: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onNavigate?: (screen: Screen) => void;
}

function Step3Vercel({ token, validation, onTokenChange, onSubmit, onSkip, onNavigate }: Step3Props) {
  const [mode, setMode] = useState<'menu' | 'input'>('menu');

  const menuItems = [
    { label: 'Enter Vercel API Token', value: 'enter' },
    { label: 'Skip for now', value: 'skip' },
    { label: '← Go Back', value: 'back' },
  ];

  const handleMenuSelect = useCallback(
    (item: { value: string }) => {
      if (item.value === 'skip') {
        onSkip();
      } else if (item.value === 'back') {
        if (onNavigate) onNavigate('welcome');
      } else {
        setMode('input');
      }
    },
    [onSkip, onNavigate],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="Step 3: Vercel Deployment"
        subtitle="Required for one-click Vercel deployment (optional)"
      />

      {mode === 'menu' && (
        <SelectInput items={menuItems} onSelect={handleMenuSelect} />
      )}

      {mode === 'input' && (
        <Box flexDirection="column">
          <Text>Vercel API Token:</Text>
          <Box marginTop={1}>
            <TextInput
              value={token}
              onChange={onTokenChange}
              onSubmit={onSubmit}
              mask="*"
              placeholder="Enter Vercel token..."
            />
          </Box>
          <Text color={UI_COLORS.subtitle}>
            Create at: vercel.com/account/tokens
          </Text>
        </Box>
      )}

      <StatusBadge state={validation} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Credentials
// ---------------------------------------------------------------------------

interface Step4Props {
  username: string;
  password: string;
  passwordConfirm: string;
  validation: ValidationState;
  onUsernameChange: (u: string) => void;
  onPasswordChange: (p: string) => void;
  onPasswordConfirmChange: (p: string) => void;
  onSubmit: () => void;
}

function Step4Credentials({
  username,
  password,
  passwordConfirm,
  validation,
  onUsernameChange,
  onPasswordChange,
  onPasswordConfirmChange,
  onSubmit,
}: Step4Props) {
  const [field, setField] = useState<'username' | 'password' | 'confirm'>('username');

  const handleUsernameSubmit = useCallback((value: string) => {
    if (value.trim().length > 0) setField('password');
  }, []);

  const handlePasswordSubmit = useCallback((value: string) => {
    if (value.trim().length > 0) setField('confirm');
  }, []);

  const handleConfirmSubmit = useCallback(
    (value: string) => {
      if (value.trim().length > 0) {
        onSubmit();
      }
    },
    [onSubmit],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="Step 4: Dashboard Credentials"
        subtitle="Secure login credentials for your deployed dashboard"
      />

      <Box flexDirection="column" gap={1}>
        {/* Username */}
        <Box flexDirection="column">
          <Text color={field === 'username' ? UI_COLORS.logo : UI_COLORS.subtitle}>
            {field === 'username' ? '▶ ' : '  '}Username:
          </Text>
          {field === 'username' ? (
            <TextInput
              value={username}
              onChange={onUsernameChange}
              onSubmit={handleUsernameSubmit}
              placeholder="admin"
            />
          ) : (
            <Text color="green">  {username || '(not set)'}</Text>
          )}
        </Box>

        {/* Password */}
        {(field === 'password' || field === 'confirm') && (
          <Box flexDirection="column">
            <Text color={field === 'password' ? UI_COLORS.logo : UI_COLORS.subtitle}>
              {field === 'password' ? '▶ ' : '  '}Password:
            </Text>
            {field === 'password' ? (
              <TextInput
                value={password}
                onChange={onPasswordChange}
                onSubmit={handlePasswordSubmit}
                mask="*"
                placeholder="Min 8 characters..."
              />
            ) : (
              <Text color="green">  {'*'.repeat(password.length)}</Text>
            )}
          </Box>
        )}

        {/* Confirm Password */}
        {field === 'confirm' && (
          <Box flexDirection="column">
            <Text color={UI_COLORS.logo}>▶ Confirm Password:</Text>
            <TextInput
              value={passwordConfirm}
              onChange={onPasswordConfirmChange}
              onSubmit={handleConfirmSubmit}
              mask="*"
              placeholder="Repeat password..."
            />
            {passwordConfirm.length > 0 && password !== passwordConfirm && (
              <Text color="red">✗ Passwords do not match</Text>
            )}
          </Box>
        )}
      </Box>

      <StatusBadge state={validation} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main SetupWizard Component
// ---------------------------------------------------------------------------

export function SetupWizard({ onComplete, onNavigate, configService }: SetupWizardProps) {
  const config = configService ?? new ConfigService();

  // Step state
  const [step, setStep] = useState<WizardStep>(1);

  // ESC key handler - go back to welcome screen
  useInput((input, key) => {
    if (key.escape && onNavigate) {
      onNavigate('welcome');
    }
  });

  // Form data
  const [llmProvider, setLLMProvider] = useState<LLMProviderName>('openai');
  const [llmApiKey, setLLMApiKey] = useState('');
  const [llmModel, setLLMModel] = useState('gpt-4o');
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434');
  const [githubToken, setGithubToken] = useState('');
  const [githubSkipped, setGithubSkipped] = useState(false);
  const [vercelToken, setVercelToken] = useState('');
  const [vercelSkipped, setVercelSkipped] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  // Validation states
  const [step1Validation, setStep1Validation] = useState<ValidationState>({ status: 'idle' });
  const [step2Validation, setStep2Validation] = useState<ValidationState>({ status: 'idle' });
  const [step3Validation, setStep3Validation] = useState<ValidationState>({ status: 'idle' });
  const [step4Validation, setStep4Validation] = useState<ValidationState>({ status: 'idle' });

  // -------------------------------------------------------------------------
  // Step 1: Validate LLM
  // -------------------------------------------------------------------------
  const handleStep1Submit = useCallback(async () => {
    const modelToUse = llmModel.trim() || DEFAULT_MODELS[llmProvider];

    // Validate required fields
    if (llmProvider !== 'ollama' && llmProvider !== 'openai-codex' && !llmApiKey.trim()) {
      setStep1Validation({ 
        status: 'error', 
        message: 'API key is required. Please enter your API key before validating.' 
      });
      return;
    }

    setStep1Validation({ status: 'validating' });
    try {
      if (llmProvider === 'openai-codex') {
        const codexProvider = LLMService.createProvider({
          provider: llmProvider,
          model: modelToUse,
        });
        let result = await codexProvider.validate();

        if (!result.valid) {
          setStep1Validation({
            status: 'validating',
            message: 'Codex is not logged in. Starting browser/device login...',
          });
          result = await OpenAICodexProvider.loginWithBrowser((msg) => {
            setStep1Validation({ status: 'validating', message: msg });
          });
        }

        if (result.valid) {
          config.set('llm.provider', llmProvider);
          config.set('llm.model', modelToUse);
          setStep1Validation({ status: 'success', message: 'Codex login validated!' });
          setTimeout(() => setStep(2), 800);
        } else {
          setStep1Validation({
            status: 'error',
            message: result.error ?? 'Codex login failed. Run "codex login" and try again.',
          });
        }
        return;
      }

      const llmConfig: LLMConfig = {
        provider: llmProvider,
        apiKey: llmApiKey.trim() || undefined,
        model: modelToUse,
        ollamaHost: ollamaHost.trim() || undefined,
      };
      const provider = LLMService.createProvider(llmConfig);
      const result = await provider.validate();

      if (result.valid) {
        // Save to config
        config.set('llm.provider', llmProvider);
        config.set('llm.model', modelToUse);
        if (llmApiKey.trim()) {
          config.setEncrypted('llm.apiKey', llmApiKey.trim());
        }
        if (llmProvider === 'ollama') {
          config.set('llm.ollamaHost', ollamaHost.trim());
        }

        setStep1Validation({ status: 'success', message: 'Connection validated!' });
        // Brief pause then advance
        setTimeout(() => setStep(2), 800);
      } else {
        // Provide user-friendly error messages
        let errorMsg = result.error ?? 'Invalid credentials';
        
        // For debugging: always show raw error for Moonshot
        if (llmProvider === 'moonshot') {
          errorMsg = `Moonshot error:\n${errorMsg}\n\n(If this doesn't help, check platform.moonshot.cn/console/api-keys)`;
        } else if (errorMsg.includes('credit balance is too low') || errorMsg.includes('Plans & Billing')) {
          errorMsg = `❌ No credits available!\n\nYour Anthropic account needs credits to use the API.\n\nFix this:\n  1. Go to: console.anthropic.com/settings/plans\n  2. Add billing or purchase credits ($5-10 minimum)\n  3. Try again after credits are added\n\nOr: Use OpenAI or Ollama (free, local) instead.`;
        } else if (errorMsg.includes('authentication_error') || errorMsg.includes('invalid x-api-key')) {
          errorMsg = `Invalid API key. Please check:\n  • Key starts with sk-ant- (Anthropic) or sk- (OpenAI/Moonshot)\n  • Key was copied completely from console\n  • Key hasn't been revoked`;
        } else if (errorMsg.includes('401')) {
          errorMsg = 'Authentication failed. Please verify your API key is correct and active.';
        }
        setStep1Validation({ status: 'error', message: errorMsg });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStep1Validation({ status: 'error', message: msg });
    }
  }, [llmProvider, llmApiKey, llmModel, ollamaHost, config]);

  // -------------------------------------------------------------------------
  // Step 2: Validate GitHub (optional)
  // -------------------------------------------------------------------------
  const handleStep2Submit = useCallback(async () => {
    if (!githubToken.trim()) {
      setStep2Validation({ status: 'error', message: 'Please enter a token or skip' });
      return;
    }

    setStep2Validation({ status: 'validating' });
    try {
      // Validate token against GitHub API
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${githubToken.trim()}`,
          'User-Agent': 'OpenBoard-TUI',
        },
      });

      if (response.ok) {
        const data = await response.json() as { login?: string };
        config.setEncrypted('github.token', githubToken.trim());
        if (data.login) config.set('github.username', data.login);

        setStep2Validation({ status: 'validating', message: `Token valid (${data.login}). Checking gh CLI...` });
        const ghAvailable = await GitHubService.isGhCliAvailable();
        if (ghAvailable) {
          await GitHubService.loginWithToken(githubToken.trim(), (msg) => {
            setStep2Validation({ status: 'validating', message: msg });
          });
          setStep2Validation({ status: 'success', message: `Authenticated as ${data.login ?? 'GitHub user'} (gh CLI ready)` });
        } else {
          setStep2Validation({ status: 'success', message: `Token saved for ${data.login ?? 'GitHub user'}. Install gh CLI manually for automatic repo creation.` });
        }
        setTimeout(() => setStep(3), 800);
      } else {
        const body = await response.json() as { message?: string };
        setStep2Validation({ status: 'error', message: body.message ?? 'Invalid GitHub token' });
      }
    } catch {
      setStep2Validation({ status: 'error', message: 'Network error — check connection' });
    }
  }, [githubToken, config]);

  const handleStep2Skip = useCallback(() => {
    setGithubSkipped(true);
    setStep(3);
  }, []);

  // -------------------------------------------------------------------------
  // Step 3: Validate Vercel (optional)
  // -------------------------------------------------------------------------
  const handleStep3Submit = useCallback(async () => {
    if (!vercelToken.trim()) {
      setStep3Validation({ status: 'error', message: 'Please enter a token or skip' });
      return;
    }

    setStep3Validation({ status: 'validating' });
    try {
      const validation = await VercelService.validateTokenForProjectAccess(vercelToken.trim());

      if (validation.success) {
        config.setEncrypted('vercel.token', vercelToken.trim());
        setStep3Validation({ status: 'success', message: 'Vercel token validated!' });
        setTimeout(() => setStep(4), 800);
      } else {
        setStep3Validation({
          status: 'error',
          message: validation.error ?? 'Invalid Vercel token',
        });
      }
    } catch {
      setStep3Validation({ status: 'error', message: 'Network error — check connection' });
    }
  }, [vercelToken, config]);

  const handleStep3Skip = useCallback(() => {
    setVercelSkipped(true);
    setStep(4);
  }, []);

  // -------------------------------------------------------------------------
  // Step 4: Save Credentials
  // -------------------------------------------------------------------------
  const handleStep4Submit = useCallback(async () => {
    // Validate inputs
    if (!username.trim()) {
      setStep4Validation({ status: 'error', message: 'Username is required' });
      return;
    }
    if (password.length < 8) {
      setStep4Validation({ status: 'error', message: 'Password must be at least 8 characters' });
      return;
    }
    if (password !== passwordConfirm) {
      setStep4Validation({ status: 'error', message: 'Passwords do not match' });
      return;
    }

    setStep4Validation({ status: 'validating', message: 'Hashing credentials...' });

    try {
      const credentials = await AuthService.prepareCredentials(username.trim(), password);

      // Save to config
      config.set('credentials.username', credentials.username);
      config.setEncrypted('credentials.passwordHash', credentials.passwordHash);
      config.setEncrypted('credentials.jwtSecret', credentials.jwtSecret);

      setStep4Validation({ status: 'success', message: 'Credentials saved securely!' });

      const finalConfig: WizardConfig = {
        llmProvider,
        llmApiKey,
        llmModel: llmModel || DEFAULT_MODELS[llmProvider],
        ollamaHost,
        githubToken,
        githubSkipped,
        vercelToken,
        vercelSkipped,
        username: username.trim(),
        password,
        passwordConfirm,
      };

      setTimeout(() => onComplete(finalConfig), 800);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStep4Validation({ status: 'error', message: msg });
    }
  }, [
    username, password, passwordConfirm,
    llmProvider, llmApiKey, llmModel, ollamaHost,
    githubToken, githubSkipped, vercelToken, vercelSkipped,
    config, onComplete,
  ]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <Box flexDirection="column" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={UI_COLORS.logo}>
          ⚡ OpenBoard Setup Wizard
        </Text>
      </Box>

      {/* Step indicator */}
      <StepIndicator current={step} total={4} />

      {/* Step content */}
      <Box borderStyle="round" borderColor={UI_COLORS.border} padding={1} flexDirection="column">
        {step === 1 && (
          <Step1LLMConfig
            provider={llmProvider}
            apiKey={llmApiKey}
            model={llmModel}
            ollamaHost={ollamaHost}
            validation={step1Validation}
            onProviderSelect={(p) => {
              setLLMProvider(p);
              setLLMModel(DEFAULT_MODELS[p]);
            }}
            onApiKeyChange={setLLMApiKey}
            onModelChange={setLLMModel}
            onOllamaHostChange={setOllamaHost}
            onSubmit={handleStep1Submit}
            onNavigate={onNavigate}
          />
        )}

        {step === 2 && (
          <Step2GitHub
            token={githubToken}
            validation={step2Validation}
            onTokenChange={setGithubToken}
            onSubmit={handleStep2Submit}
            onSkip={handleStep2Skip}
            onNavigate={onNavigate}
          />
        )}

        {step === 3 && (
          <Step3Vercel
            token={vercelToken}
            validation={step3Validation}
            onTokenChange={setVercelToken}
            onSubmit={handleStep3Submit}
            onSkip={handleStep3Skip}
            onNavigate={onNavigate}
          />
        )}

        {step === 4 && (
          <Step4Credentials
            username={username}
            password={password}
            passwordConfirm={passwordConfirm}
            validation={step4Validation}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onPasswordConfirmChange={setPasswordConfirm}
            onSubmit={handleStep4Submit}
          />
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>
          Press Ctrl+C to exit • Arrow keys to navigate • Enter to confirm
        </Text>
      </Box>
    </Box>
  );
}

export default SetupWizard;
