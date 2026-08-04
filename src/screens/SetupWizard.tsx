/**
 * SetupWizard — mode-first TUI setup wizard for OpenBoard initial configuration.
 *
 * Guides the user through:
 *  Step 1: App mode — Local only / Hybrid / All remote. Picked FIRST so the
 *          user knows from the beginning what the end result is and what
 *          leaves their machine.
 *  Step 2: LLM provider (filtered by mode: Local only ⇒ Ollama/LM Studio) + key + model
 *  Step 3: GitHub Personal Access Token   (All remote mode only)
 *  Step 4: Vercel API token               (All remote mode only)
 *  Step 5: Dashboard username + password → bcrypt hash + JWT secret
 *
 * Uses Ink for TUI rendering, ink-text-input for text fields.
 * Calls AuthService.prepareCredentials and saves to ConfigService on completion.
 */

import React, { useState, useCallback, useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';

import { LocalModelPicker } from '../components/LocalModelPicker.js';
import { AuthService } from '../services/auth/AuthService.js';
import { LLMService } from '../services/llm/LLMService.js';
import { OpenAICodexProvider } from '../services/llm/OpenAICodexProvider.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { GitHubService } from '../services/deploy/GitHubService.js';
import { VercelService } from '../services/deploy/VercelService.js';
import type { LLMConfig, LLMEffort, LLMProviderName } from '../types/llm.js';
import { DEFAULT_EFFORT, DEFAULT_MODELS, EFFORT_CHOICES, LLM_PROVIDER_CHOICES, MODEL_CHOICES } from '../config/llmCatalog.js';
import { APP_MODES, allowedProvidersForMode, appModeInfo, getAppMode, modeAllowsDeploy, type AppMode } from '../config/appModes.js';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
import { setupWizardNavigationReducer, visibleWizardSteps } from './setupWizardReducer.js';
import type { WizardStep } from './setupWizardReducer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationState {
  status: 'idle' | 'validating' | 'success' | 'error';
  message?: string;
}

interface WizardConfig {
  // Step 0
  mode: AppMode;
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
  ...LLM_PROVIDER_CHOICES,
  { label: '← Go Back', value: 'back' },
];

/** Providers selectable in the chosen mode (Local only ⇒ Ollama/LM Studio), plus Back. */
function providersForMode(mode: AppMode): Array<{ label: string; value: string }> {
  const allowed = new Set<string>(allowedProvidersForMode(mode));
  return LLM_PROVIDERS.filter((item) => item.value === 'back' || allowed.has(item.value));
}

// Model lists, default models, and effort levels live in the shared catalog
// (src/config/llmCatalog.ts) so the wizard, the in-chat /model command, and
// `openboard agent setup` validation stay in sync.

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
// Step 0: App mode — picked first so the end result is clear from the start
// ---------------------------------------------------------------------------

interface StepModeProps {
  onModeSelect: (mode: AppMode) => void;
  onBack?: () => void;
}

function StepModeSelect({ onModeSelect, onBack }: StepModeProps) {
  // Detail for the highlighted option renders below the list, so each mode is
  // described exactly once instead of a legend + a duplicate select list.
  const [highlighted, setHighlighted] = useState<AppMode>(APP_MODES[0].id);

  const items = [
    ...APP_MODES.map((mode, index) => ({
      label: `${index + 1}. ${mode.label} — ${mode.summary}`,
      value: mode.id as string,
    })),
    { label: '← Go Back', value: 'back' },
  ];

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="Step 1: Choose your mode"
        subtitle="This decides what you get at the end — and what leaves your machine"
      />

      <SelectInput
        items={items}
        onHighlight={(item) => {
          if (item.value !== 'back') setHighlighted(item.value as AppMode);
        }}
        onSelect={(item) => {
          if (item.value === 'back') {
            onBack?.();
            return;
          }
          onModeSelect(item.value as AppMode);
        }}
      />

      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>{appModeInfo(highlighted).detail}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 1: LLM Configuration
// ---------------------------------------------------------------------------

interface Step1Props {
  mode: AppMode;
  stepLabel: string;
  provider: LLMProviderName;
  apiKey: string;
  model: string;
  ollamaHost: string;
  validation: ValidationState;
  onProviderSelect: (p: LLMProviderName) => void;
  onApiKeyChange: (k: string) => void;
  onModelChange: (m: string) => void;
  onEffortChange: (e: LLMEffort) => void;
  onOllamaHostChange: (h: string) => void;
  onSubmit: () => void;
  onBack?: () => void;
}

function Step1LLMConfig({
  mode,
  stepLabel,
  provider,
  apiKey,
  model,
  ollamaHost,
  validation,
  onProviderSelect,
  onApiKeyChange,
  onModelChange,
  onEffortChange,
  onOllamaHostChange,
  onSubmit,
  onBack,
}: Step1Props) {
  const [phase, setPhase] = useState<'provider' | 'key' | 'model' | 'effort' | 'host'>('provider');

  // Handle provider selection
  const handleProviderSelect = useCallback(
    (item: { value: string }) => {
      // Handle "Go Back" option
      if (item.value === 'back') {
        onBack?.();
        return;
      }
      
      const p = item.value as LLMProviderName;
      onProviderSelect(p);
      if (p === 'ollama' || p === 'lmstudio') {
        onOllamaHostChange(p === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434');
        setPhase('host');
      } else if (p === 'openai-codex') {
        setPhase('model');
      } else {
        setPhase('key');
      }
    },
    [onProviderSelect, onBack, onOllamaHostChange],
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

  // Handle effort selection → validate
  const handleEffortSelect = useCallback(
    (item: { value: string }) => {
      onEffortChange(item.value as LLMEffort);
      // Auto-submit after selection
      setTimeout(() => {
        onSubmit();
      }, 150);
    },
    [onEffortChange, onSubmit],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title={`${stepLabel}: LLM Provider`}
        subtitle={
          mode === 'local'
            ? 'Local only mode: generation runs on your machine via Ollama or LM Studio'
            : 'Choose the AI provider for code generation'
        }
      />

      {phase === 'provider' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Select your LLM provider:</Text>
          <Box marginTop={1}>
            <SelectInput items={providersForMode(mode)} onSelect={handleProviderSelect} />
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
               provider === 'gemini' ? 'Google Gemini (AI Studio)' :
               provider === 'xai' ? 'xAI' :
               provider === 'mistral' ? 'Mistral AI' :
               provider === 'openrouter' ? 'OpenRouter' :
               'API'} API Key:
            </Text>
            <TextInput
              value={apiKey}
              onChange={onApiKeyChange}
              onSubmit={handleKeySubmit}
              mask="*"
              placeholder={provider === 'gemini' ? 'AIza...' : 'sk-...'}
            />
          </Box>
        </Box>
      )}

      {phase === 'host' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Provider: {provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} (Local)</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{provider === 'lmstudio' ? 'LM Studio OpenAI API URL:' : 'Ollama Host URL:'}</Text>
            <TextInput
              value={ollamaHost}
              onChange={onOllamaHostChange}
              onSubmit={handleHostSubmit}
              placeholder={provider === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434'}
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
              {provider === 'ollama' || provider === 'lmstudio' ? (
                <LocalModelPicker
                  provider={provider}
                  host={ollamaHost}
                  staticChoices={MODEL_CHOICES[provider]}
                  onPick={(value) => {
                    onModelChange(value);
                    setPhase('effort');
                  }}
                />
              ) : (
                <SelectInput
                  items={MODEL_CHOICES[provider]}
                  onSelect={(item) => {
                    onModelChange(item.value);
                    setPhase('effort');
                  }}
                />
              )}
            </Box>
          </Box>
          <HintBar keys={['move', 'continue', 'back']} />
        </Box>
      )}

      {phase === 'effort' && (
        <Box flexDirection="column">
          <Text color={UI_COLORS.logo}>Provider: {provider} · Model: {model}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={UI_COLORS.logo}>Select execution effort:</Text>
            <Box marginTop={1}>
              <SelectInput items={EFFORT_CHOICES} onSelect={handleEffortSelect} />
            </Box>
          </Box>
          <HintBar keys={['move', 'select', 'back']} />
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
  stepLabel: string;
  token: string;
  validation: ValidationState;
  onTokenChange: (t: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

function Step2GitHub({ stepLabel, token, validation, onTokenChange, onSubmit, onSkip, onBack }: Step2Props) {
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
        onBack?.();
      } else {
        setMode('input');
      }
    },
    [onSkip, onBack],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title={`${stepLabel}: GitHub Integration`}
        subtitle="All remote mode: create a repo and push dashboard code to GitHub"
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
  stepLabel: string;
  token: string;
  validation: ValidationState;
  onTokenChange: (t: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

function Step3Vercel({ stepLabel, token, validation, onTokenChange, onSubmit, onSkip, onBack }: Step3Props) {
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
        onBack?.();
      } else {
        setMode('input');
      }
    },
    [onSkip, onBack],
  );

  return (
    <Box flexDirection="column">
      <SectionHeader
        title={`${stepLabel}: Vercel Deployment`}
        subtitle="All remote mode: required for the live web app deployment"
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
  stepLabel: string;
  mode: AppMode;
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
  stepLabel,
  mode,
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
        title={`${stepLabel}: Dashboard Credentials`}
        subtitle={
          modeAllowsDeploy(mode)
            ? 'Secure login credentials for your deployed dashboard'
            : 'Login credentials for your locally previewed dashboard'
        }
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

  // Step state — mode first, so the end result is clear from the beginning.
  const [navigation, dispatchNavigation] = useReducer(setupWizardNavigationReducer, {
    step: 'mode',
    mode: getAppMode(config),
  });
  const { step, mode } = navigation;

  // Which steps this wizard run walks through, given the chosen mode.
  const visibleSteps = visibleWizardSteps(mode);
  const stepNumber = visibleSteps.indexOf(step) + 1;
  const stepLabelFor = (s: WizardStep) => `Step ${visibleSteps.indexOf(s) + 1}`;

  // Step back one wizard screen; only the first step exits to the menu, so a
  // wrong choice can be revised without restarting the whole wizard.
  const goBack = useCallback(() => {
    const index = visibleSteps.indexOf(step);
    if (index <= 0) {
      onNavigate?.('welcome');
    } else {
      dispatchNavigation({ type: 'go', step: visibleSteps[index - 1] });
    }
  }, [visibleSteps, step, onNavigate]);

  // ESC = back one step (exit to menu from the first step)
  useInput((_input, key) => {
    if (key.escape) {
      goBack();
    }
  });

  // Form data
  const [llmProvider, setLLMProvider] = useState<LLMProviderName>('openai');
  const [llmApiKey, setLLMApiKey] = useState('');
  const [llmModel, setLLMModel] = useState(DEFAULT_MODELS.openai);
  const [llmEffort, setLLMEffort] = useState<LLMEffort>(DEFAULT_EFFORT);
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434');
  const [githubToken, setGithubToken] = useState('');
  const [githubSkipped, setGithubSkipped] = useState(false);
  const [vercelToken, setVercelToken] = useState('');
  const [vercelSkipped, setVercelSkipped] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  // -------------------------------------------------------------------------
  // Step 0: Mode selection — saved immediately so every later surface
  // (chat commands, pipeline, agent CLI) reads the same contract.
  // -------------------------------------------------------------------------
  const handleModeSelect = useCallback((selected: AppMode) => {
    config.set('app.mode', selected);
    if (selected === 'local') {
      // Local only: generation must stay on-machine.
      setLLMProvider('ollama');
      setLLMModel(DEFAULT_MODELS.ollama);
    }
    dispatchNavigation({ type: 'select_mode', mode: selected });
  }, [config]);

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
    if (llmProvider !== 'ollama' && llmProvider !== 'lmstudio' && llmProvider !== 'openai-codex' && !llmApiKey.trim()) {
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
          config.set('llm.effort', llmEffort);
          setStep1Validation({ status: 'success', message: 'Codex login validated!' });
          setTimeout(() => dispatchNavigation({ type: 'llm_complete' }), 800);
        } else {
          setStep1Validation({
            status: 'error',
            message: result.error ?? 'Codex login failed. Re-select OpenAI Codex here to retry — OpenBoard signs in to its own codex home.',
          });
        }
        return;
      }

      const llmConfig: LLMConfig = {
        provider: llmProvider,
        apiKey: llmApiKey.trim() || undefined,
        model: modelToUse,
        ollamaHost: ollamaHost.trim() || undefined,
        baseUrl: llmProvider === 'lmstudio' ? ollamaHost.trim() || undefined : undefined,
      };
      const provider = LLMService.createProvider(llmConfig);
      const result = await provider.validate();

      if (result.valid) {
        // Save to config
        config.set('llm.provider', llmProvider);
        config.set('llm.model', modelToUse);
        config.set('llm.effort', llmEffort);
        if (llmApiKey.trim()) {
          config.setEncrypted('llm.apiKey', llmApiKey.trim());
        }
        if (llmProvider === 'ollama') {
          config.set('llm.ollamaHost', ollamaHost.trim());
        } else if (llmProvider === 'lmstudio') {
          config.set('llm.baseUrl', ollamaHost.trim());
        }

        setStep1Validation({ status: 'success', message: 'Connection validated!' });
        // Brief pause then advance
        setTimeout(() => dispatchNavigation({ type: 'llm_complete' }), 800);
      } else {
        // Provide user-friendly error messages
        let errorMsg = result.error ?? 'Invalid credentials';
        
        // For debugging: always show raw error for Moonshot
        if (llmProvider === 'moonshot') {
          errorMsg = `Moonshot error:\n${errorMsg}\n\n(If this doesn't help, check platform.kimi.ai/console/api-keys)`;
        } else if (llmProvider === 'gemini') {
          errorMsg = `Gemini error:\n${errorMsg}\n\n(Get a Gemini API key at aistudio.google.com/apikey and enable billing if the selected model requires it.)`;
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
  }, [llmProvider, llmApiKey, llmModel, llmEffort, ollamaHost, config]);

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
        setTimeout(() => dispatchNavigation({ type: 'github_complete' }), 800);
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
    dispatchNavigation({ type: 'github_complete' });
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
        setTimeout(() => dispatchNavigation({ type: 'vercel_complete' }), 800);
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
    dispatchNavigation({ type: 'vercel_complete' });
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
        mode,
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
    mode, llmProvider, llmApiKey, llmModel, ollamaHost,
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
      <StepIndicator current={stepNumber} total={visibleSteps.length} />

      {/* Step content */}
      <Box borderStyle="round" borderColor={UI_COLORS.border} padding={1} flexDirection="column">
        {step === 'mode' && (
          <StepModeSelect onModeSelect={handleModeSelect} onBack={goBack} />
        )}

        {step === 'llm' && (
          <Step1LLMConfig
            mode={mode}
            stepLabel={stepLabelFor('llm')}
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
            onEffortChange={setLLMEffort}
            onOllamaHostChange={setOllamaHost}
            onSubmit={handleStep1Submit}
            onBack={goBack}
          />
        )}

        {step === 'github' && (
          <Step2GitHub
            stepLabel={stepLabelFor('github')}
            token={githubToken}
            validation={step2Validation}
            onTokenChange={setGithubToken}
            onSubmit={handleStep2Submit}
            onSkip={handleStep2Skip}
            onBack={goBack}
          />
        )}

        {step === 'vercel' && (
          <Step3Vercel
            stepLabel={stepLabelFor('vercel')}
            token={vercelToken}
            validation={step3Validation}
            onTokenChange={setVercelToken}
            onSubmit={handleStep3Submit}
            onSkip={handleStep3Skip}
            onBack={goBack}
          />
        )}

        {step === 'credentials' && (
          <Step4Credentials
            stepLabel={stepLabelFor('credentials')}
            mode={mode}
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
