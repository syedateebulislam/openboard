import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { WelcomeScreen } from './screens/WelcomeScreen.js';
import { SetupWizard } from './screens/SetupWizard.js';
import { BoardCreationScreen } from './screens/BoardCreationScreen.js';
import { ChatScreen } from './screens/ChatScreen.js';
import { ManageBoardsScreen } from './screens/ManageBoardsScreen.js';
import { LocalModelPicker } from './components/LocalModelPicker.js';
import { ProjectManager } from './services/project/ProjectManager.js';
import { ConfigService } from './services/config/ConfigService.js';
import { LLMService } from './services/llm/LLMService.js';
import { OpenAICodexProvider } from './services/llm/OpenAICodexProvider.js';
import { GitHubService } from './services/deploy/GitHubService.js';
import { VercelService } from './services/deploy/VercelService.js';
import { AuthService } from './services/auth/AuthService.js';
import type { LLMConfig, LLMProviderName } from './types/llm.js';
import type { BoardConfig } from './types/board.js';
import { billerSchedulerArmKey, startBillerScheduler } from './services/billers/billerScheduler.js';
import { TypedConfigRepository } from './services/config/TypedConfigRepository.js';
import type { BillerSchedulerStatus } from './types/billers.js';
import { GmailIntegrationScreen } from './screens/GmailIntegrationScreen.js';
import { IntegrationsScreen } from './screens/IntegrationsScreen.js';
import { BillerStudioScreen } from './screens/BillerStudioScreen.js';
import { ScreenFrame } from './components/ScreenFrame.js';
import { Spinner } from './components/Spinner.js';
import { UI_COLORS } from './theme.js';
import {
  APP_MODES,
  appModeInfo,
  describeAppMode,
  getAppMode,
  modeAllowsDeploy,
  providerAllowedInMode,
  providerModeMismatchMessage,
  type AppMode,
} from './config/appModes.js';
import { DEFAULT_MODELS, LLM_PROVIDER_CHOICES, MODEL_CHOICES } from './config/llmCatalog.js';

const projectManager = new ProjectManager();

export type Screen =
  | 'welcome'
  | 'setup'
  | 'create-board'
  | 'manage-boards'
  | 'chat'
  | 'deploy'
  | 'integrations'
  // Gmail sits under Integrations, not Settings: reading invoices is a way data
  // gets into OpenBoardCLI, not a preference about how it behaves.
  | 'integrations-gmail'
  | 'settings'
  | 'settings-mode'
  | 'settings-vercel'
  | 'settings-github'
  | 'settings-llm'
  | 'settings-dashboard-auth'
  | 'biller-studio';

/** One line per settings row, shown for the highlighted one. */
const SETTINGS_DETAIL: Record<string, string> = {
  mode: 'What OpenBoardCLI produces — and what leaves your machine.',
  llm: 'Which model generates dashboards, and where it runs.',
  github: 'Token used to push the generated app. Encrypted locally.',
  vercel: 'Token used to deploy. Encrypted locally.',
  'dashboard-auth': 'Username and password for the deployed dashboard.',
  setup: 'Re-run onboarding from the start.',
  back: 'Return to the main menu.',
};

export function SettingsPlaceholder({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [highlighted, setHighlighted] = useState('mode');

  useInput((_input, key) => {
    if (key.escape) onNavigate('welcome');
  });

  const mode = getAppMode();
  const remote = modeAllowsDeploy(mode);

  // GitHub/Vercel tokens only matter in the deploying modes — hiding them keeps
  // the privacy contract visible: the preview-only modes never talk to
  // GitHub/Vercel.
  const items = [
    { label: 'App mode', value: 'mode' },
    { label: 'LLM provider', value: 'llm' },
    ...(remote
      ? [
          { label: 'GitHub token', value: 'github' },
          { label: 'Vercel token', value: 'vercel' },
        ]
      : []),
    { label: 'Dashboard login', value: 'dashboard-auth' },
    { label: 'Re-run onboarding', value: 'setup' },
    { label: '← Back', value: 'back' },
  ];

  return (
    <ScreenFrame
      title="Settings"
      meta={[describeAppMode(mode).toLowerCase()]}
      detail={SETTINGS_DETAIL[highlighted]}
      hints={['move', 'select', 'back']}
    >
      <Box>
        <SelectInput
          items={items}
          onHighlight={(item) => setHighlighted(item.value)}
          onSelect={(item) => {
            if (item.value === 'mode') onNavigate('settings-mode');
            else if (item.value === 'llm') onNavigate('settings-llm');
            else if (item.value === 'github') onNavigate('settings-github');
            else if (item.value === 'vercel') onNavigate('settings-vercel');
            else if (item.value === 'dashboard-auth') onNavigate('settings-dashboard-auth');
            else if (item.value === 'setup') onNavigate('setup');
            else onNavigate('welcome');
          }}
        />
      </Box>
    </ScreenFrame>
  );
}

export function AppModeSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [status, setStatus] = useState('');
  // Detail for the highlighted option renders below the list — each mode is
  // described once instead of a legend duplicating the select entries.
  const [highlighted, setHighlighted] = useState<AppMode>(APP_MODES[0].id);

  useInput((_input, key) => {
    if (key.escape) onNavigate('settings');
  });

  const currentMode = getAppMode();

  // The summary moves to the detail line — it described the highlighted mode
  // twice, once in the row and once below it.
  const items = [
    ...APP_MODES.map((m) => ({
      label: m.id === currentMode ? `${m.label}  (current)` : m.label,
      value: m.id as string,
    })),
    { label: '← Back', value: 'back' },
  ];

  const selectMode = (selected: AppMode) => {
    const config = new ConfigService();
    config.set('app.mode', selected);

    const notes: string[] = [`Mode set to: ${describeAppMode(selected)}`];
    const provider = config.get('llm.provider') as string | undefined;
    if (provider && !providerAllowedInMode(provider, selected)) {
      notes.push(providerModeMismatchMessage(provider, selected));
    }
    if (modeAllowsDeploy(selected) && !config.has('vercel.token')) {
      notes.push(`${appModeInfo(selected).label} mode needs GitHub/Vercel tokens — add them in Settings.`);
    }
    setStatus(notes.join('\n'));
  };

  return (
    <ScreenFrame
      title={['Settings', 'App mode']}
      meta={[`current: ${describeAppMode(currentMode).toLowerCase()}`]}
      detail={appModeInfo(highlighted).detail}
      status={status}
      statusTone="ok"
      hints={['move', 'select', 'back']}
    >
      <Box>
        <SelectInput
          items={items}
          onHighlight={(item) => {
            if (item.value !== 'back') setHighlighted(item.value as AppMode);
          }}
          onSelect={(item) => {
            if (item.value === 'back') onNavigate('settings');
            else selectMode(item.value as AppMode);
          }}
        />
      </Box>
    </ScreenFrame>
  );
}

export function DashboardAuthSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [step, setStep] = useState<'username' | 'password'>('username');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  // Esc is ignored while a save is in flight. Leaving mid-await does not
  // cancel the work — it completes and writes config for a screen the user is
  // no longer looking at, so they never learn whether it succeeded.
  useInput((_input, key) => {
    if (key.escape && !saving) onNavigate('settings');
  });

  const saveCredentials = async () => {
    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setStatus('Username is required.');
      setStep('username');
      return;
    }
    if (password.length < 8) {
      setStatus('Password must be at least 8 characters.');
      setStep('password');
      return;
    }

    setSaving(true);
    setStatus('Hashing and saving dashboard credentials...');
    try {
      const credentials = await AuthService.prepareCredentials(cleanUsername, password);
      const config = new ConfigService();
      config.set('credentials.username', credentials.username);
      config.setEncrypted('credentials.passwordHash', credentials.passwordHash);
      config.setEncrypted('credentials.jwtSecret', credentials.jwtSecret);
      setPassword('');
      setStatus('Dashboard login saved. Run /deploy again to update Vercel env vars.');
    } catch (error: any) {
      setStatus(`Could not save dashboard login: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenFrame
      title={['Settings', 'Dashboard login']}
      detail={step === 'username'
        ? 'The username for signing in to your deployed dashboard.'
        : 'At least 8 characters. Hashed with bcrypt before it is stored.'}
      status={status}
      statusTone={saving ? 'busy' : undefined}
      hints={[step === 'username' ? 'continue' : 'save', 'back']}
    >
      {step === 'username' ? (
        <Box>
          <Text color={UI_COLORS.logo}>Username › </Text>
          <TextInput
            value={username}
            onChange={setUsername}
            onSubmit={() => setStep('password')}
            placeholder="admin"
          />
        </Box>
      ) : (
        <Box>
          <Text color={UI_COLORS.logo}>Password › </Text>
          <TextInput
            value={password}
            onChange={setPassword}
            onSubmit={saveCredentials}
            mask="*"
            placeholder="at least 8 characters"
          />
        </Box>
      )}
    </ScreenFrame>
  );
}

export function GitHubTokenSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  // Held while the token is being validated against the GitHub API — see the
  // note in DashboardAuthSettings.
  useInput((_input, key) => {
    if (key.escape && !saving) onNavigate('settings');
  });

  const saveToken = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setSaving(true);
    setStatus('Validating GitHub token...');
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'User-Agent': 'OpenBoardCLI-TUI',
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        setStatus(`Invalid GitHub token. ${body.slice(0, 160)}`);
        return;
      }

      const data = await response.json() as { login?: string };
      const config = new ConfigService();
      config.setEncrypted('github.token', trimmed);
      if (data.login) config.set('github.username', data.login);

      await GitHubService.loginWithToken(trimmed, (line) => setStatus(line));
      setStatus(`GitHub token saved${data.login ? ` for ${data.login}` : ''}.`);
      setToken('');
    } catch (error: any) {
      setStatus(`Could not validate token: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenFrame
      title={['Settings', 'GitHub token']}
      detail="Needs repo scope. Validated against GitHub, then encrypted locally."
      status={status}
      statusTone={saving ? 'busy' : undefined}
      hints={['save', 'back']}
    >
      <Box>
        <Text color={UI_COLORS.logo}>Token › </Text>
        <TextInput
          value={token}
          onChange={setToken}
          onSubmit={saveToken}
          mask="*"
          placeholder="ghp_... or github_pat_..."
        />
      </Box>
    </ScreenFrame>
  );
}

type LLMSettingsStep = 'provider' | 'apiKey' | 'model' | 'ollamaHost' | 'saving';

const LLM_PROVIDER_ITEMS: Array<{ label: string; value: LLMProviderName | 'back' }> = [
  ...LLM_PROVIDER_CHOICES.map(({ label, value }) => ({ label, value })),
  { label: '← Go Back', value: 'back' },
];

export function LLMSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [step, setStep] = useState<LLMSettingsStep>('provider');
  const [provider, setProvider] = useState<LLMProviderName>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODELS.openai);
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434');
  const [status, setStatus] = useState('');

  // Held while the provider is being validated — which for a local model or a
  // browser login is the longest wait in settings.
  useInput((_input, key) => {
    if (key.escape && step !== 'saving') onNavigate('settings');
  });

  const saveLLM = async (modelOverride?: string) => {
    setStep('saving');
    setStatus('Validating LLM settings...');
    try {
      const selectedModel = modelOverride?.trim() || model.trim() || DEFAULT_MODELS[provider];

      if (provider === 'openai-codex') {
        const validation = await new OpenAICodexProvider(selectedModel).validate();
        if (!validation.valid) {
          setStatus('Codex is not logged in. Starting browser/device login...');
          const login = await OpenAICodexProvider.loginWithBrowser((line) => setStatus(line));
          if (!login.valid) {
            setStatus(login.error ?? 'Codex login failed.');
            setStep('provider');
            return;
          }
        }

        const config = new ConfigService();
        config.set('llm.provider', provider);
        config.set('llm.model', selectedModel);
        setStatus('OpenAI Codex settings saved.');
        setStep('provider');
        return;
      }

      const configToValidate: LLMConfig = {
        provider,
        model: selectedModel,
        apiKey: apiKey.trim() || undefined,
        ollamaHost: ollamaHost.trim() || undefined,
        baseUrl: provider === 'lmstudio' ? ollamaHost.trim() || undefined : undefined,
      };

      if (provider !== 'ollama' && provider !== 'lmstudio' && !configToValidate.apiKey) {
        setStatus('API key is required for this provider.');
        setStep('apiKey');
        return;
      }

      const llm = LLMService.createProvider(configToValidate);
      const validation = await llm.validate();
      if (!validation.valid) {
        setStatus(validation.error ?? 'LLM validation failed.');
        setStep(provider === 'ollama' || provider === 'lmstudio' ? 'ollamaHost' : 'apiKey');
        return;
      }

      const config = new ConfigService();
      config.set('llm.provider', provider);
      config.set('llm.model', selectedModel);
      if (provider === 'ollama') {
        config.set('llm.ollamaHost', ollamaHost.trim());
      } else if (provider === 'lmstudio') {
        config.set('llm.baseUrl', ollamaHost.trim());
      } else if (apiKey.trim()) {
        config.setEncrypted('llm.apiKey', apiKey.trim());
      }
      setStatus('LLM settings saved.');
      setApiKey('');
      setStep('provider');
    } catch (error: any) {
      setStatus(`Could not save LLM settings: ${error.message}`);
      setStep(provider === 'ollama' || provider === 'lmstudio' ? 'ollamaHost' : provider === 'openai-codex' ? 'provider' : 'apiKey');
    }
  };

  if (step === 'provider') {
    const mode = getAppMode();
    const providerItems = LLM_PROVIDER_ITEMS.filter(
      (item) => item.value === 'back' || providerAllowedInMode(item.value, mode),
    );
    return (
      <ScreenFrame
        title={['Settings', 'LLM provider']}
        meta={[mode === 'local' && 'local only — runs on your machine']}
        detail="Choose the provider to configure."
        status={status}
        hints={['move', 'select', 'back']}
      >
        <Box>
          <SelectInput
            items={providerItems}
            onSelect={(item) => {
              if (item.value === 'back') {
                onNavigate('settings');
                return;
              }
              setProvider(item.value);
              setModel(DEFAULT_MODELS[item.value]);
              if (item.value === 'lmstudio') setOllamaHost('http://127.0.0.1:1234/v1');
              if (item.value === 'ollama') setOllamaHost('http://127.0.0.1:11434');
              setStep(item.value === 'ollama' || item.value === 'lmstudio' ? 'ollamaHost' : item.value === 'openai-codex' ? 'model' : 'apiKey');
            }}
          />
        </Box>
      </ScreenFrame>
    );
  }

  if (step === 'apiKey') {
    return (
      <ScreenFrame
        title={['Settings', 'LLM provider', 'API key']}
        meta={[provider]}
        detail="Stored encrypted on this machine."
        status={status}
        statusTone="error"
        hints={['continue', 'back']}
      >
        <Box>
          <Text color={UI_COLORS.logo}>API key › </Text>
          <TextInput value={apiKey} onChange={setApiKey} onSubmit={() => setStep('model')} mask="*" placeholder="sk-..." />
        </Box>
      </ScreenFrame>
    );
  }

  if (step === 'ollamaHost') {
    return (
      <ScreenFrame
        title={['Settings', 'LLM provider', provider === 'lmstudio' ? 'LM Studio server' : 'Ollama host']}
        detail="Where the local server is listening. Nothing leaves your machine."
        status={status}
        statusTone="error"
        hints={['continue', 'back']}
      >
        <Box>
          <Text color={UI_COLORS.logo}>Host › </Text>
          <TextInput value={ollamaHost} onChange={setOllamaHost} onSubmit={() => setStep('model')} placeholder={provider === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434'} />
        </Box>
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame
      title={['Settings', 'LLM provider', 'Model']}
      meta={[provider]}
      detail="Validated against the provider before it is saved."
      status={status}
      statusTone={step === 'saving' ? 'busy' : undefined}
      hints={['move', 'select', 'back']}
    >
      <Box>
        {provider === 'ollama' || provider === 'lmstudio' ? (
          <LocalModelPicker
            provider={provider}
            host={ollamaHost}
            staticChoices={MODEL_CHOICES[provider]}
            onPick={(value) => {
              setModel(value);
              setTimeout(() => void saveLLM(value), 0);
            }}
          />
        ) : (
          <SelectInput
            items={MODEL_CHOICES[provider]}
            onSelect={(item) => {
              setModel(item.value);
              setTimeout(() => void saveLLM(item.value), 0);
            }}
          />
        )}
      </Box>
    </ScreenFrame>
  );
}

export function VercelTokenSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  // Held while the token is being validated for project access.
  useInput((_input, key) => {
    if (key.escape && !saving) onNavigate('settings');
  });

  const saveToken = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setSaving(true);
    setStatus('Validating Vercel token...');
    try {
      const validation = await VercelService.validateTokenForProjectAccess(trimmed);

      if (!validation.success) {
        setStatus(`Invalid Vercel token. ${(validation.error ?? '').slice(0, 220)}`);
        return;
      }

      new ConfigService().setEncrypted('vercel.token', trimmed);
      setStatus('Vercel token saved. You can return to your dashboard and run deploy again.');
      setToken('');
    } catch (error: any) {
      setStatus(`Could not validate token: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenFrame
      title={['Settings', 'Vercel token']}
      detail="Validated for project access, then encrypted locally."
      status={status}
      statusTone={saving ? 'busy' : undefined}
      hints={['save', 'back']}
    >
      <Box>
        <Text color={UI_COLORS.logo}>Token › </Text>
        <TextInput
          value={token}
          onChange={setToken}
          onSubmit={saveToken}
          mask="*"
          placeholder="vercel token..."
        />
      </Box>
    </ScreenFrame>
  );
}

export function DeployPlaceholder({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  useInput((_input, key) => {
    if (key.escape) onNavigate('welcome');
  });

  return (
    <ScreenFrame
      title="Deploy"
      detail="Deploying happens from a dashboard's chat. This screen is not built yet."
      hints={['select', 'back']}
    >
      <Box>
        <SelectInput items={[{ label: '← Back', value: 'back' }]} onSelect={() => onNavigate('welcome')} />
      </Box>
    </ScreenFrame>
  );
}

// Default board config for chat screen
const defaultBoard: BoardConfig = {
  id: 'default',
  name: 'my-board',
  title: 'My Dashboard',
  type: 'custom',
  outputDir: '',
  dataFiles: [],
  components: [],
  createdAt: new Date().toISOString(),
};

export function App() {
  // First run: with no LLM configured every dashboard path dead-ends, so land
  // new users in the setup wizard instead of the menu.
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      return new ConfigService().get('llm.provider') ? 'welcome' : 'setup';
    } catch {
      return 'setup';
    }
  });
  const [currentBoard, setCurrentBoard] = useState<BoardConfig>(defaultBoard);
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false);
  const [allBoardsMode, setAllBoardsMode] = useState(false);
  const [scaffoldError, setScaffoldError] = useState<string | null>(null);
  // Scaffolding copies the whole template and writes .env. It is not
  // instantaneous, and until now it rendered nothing at all — the creation
  // screen simply sat there, indistinguishable from a hang, and only spoke up
  // if it failed.
  const [scaffolding, setScaffolding] = useState(false);
  const [billerConfigVersion, setBillerConfigVersion] = useState(0);
  const [billerStatus, setBillerStatus] = useState<BillerSchedulerStatus | null>(null);

  // Same lifecycle for the invoice fetchers, but it only fires when a full
  // interval has elapsed since the last run — see billerScheduler for why.
  //
  // The status is held in state rather than dropped: the loop is otherwise
  // completely silent, so a working interval and a broken one looked identical
  // from the TUI.
  //
  // Re-arm only on the two things a running loop cannot pick up by itself: the
  // interval it captured, and whether it is configured at all. Everything else
  // — enabled billers, the address, the password — is re-read from config on
  // each tick, so restarting for those achieved nothing and cost something:
  // arming schedules an overdue run immediately, so once the schedule was due,
  // every settings change kicked off a full fetch. Toggling a biller started
  // one, which is what made entering this screen look like it triggered a run.
  const billerArmKey = useMemo(
    () => billerSchedulerArmKey(new TypedConfigRepository().getBillerSettings()),
    [billerConfigVersion],
  );

  useEffect(() => startBillerScheduler(setBillerStatus), [billerArmKey]);

  const navigate = (s: Screen) => setScreen(s);

  const handleSetupComplete = () => {
    navigate('manage-boards');
  };

  const handleBoardCreated = useCallback(async (board: BoardConfig) => {
    setScaffoldError(null);
    setScaffolding(true);
    try {
      const result = await projectManager.scaffold(board);
      if (result.success) {
        setCurrentBoard(result.board);
        setShouldAutoGenerate(true);
        setAllBoardsMode(false);
        navigate('chat');
      } else {
        setScaffoldError(result.error || 'Failed to scaffold project');
      }
    } catch (error) {
      // scaffold() returns its failures, but a throw here would previously
      // have left the screen stuck on the busy state forever.
      setScaffoldError(error instanceof Error ? error.message : String(error));
    } finally {
      setScaffolding(false);
    }
  }, []);

  const handleBoardSelected = useCallback((board: BoardConfig) => {
    setCurrentBoard(board);
    setShouldAutoGenerate(false);
    setAllBoardsMode(false);
    navigate('chat');
  }, []);

  // "Modify all dashboards" — open the internal chat in all-boards mode, where
  // each prompt is applied to every dashboard and deployed once.
  const handleModifyAll = useCallback(() => {
    setCurrentBoard(defaultBoard);
    setShouldAutoGenerate(false);
    setAllBoardsMode(true);
    navigate('chat');
  }, []);

  switch (screen) {
    case 'welcome':
      return <WelcomeScreen onNavigate={navigate} />;
    
    case 'setup': 
      return <SetupWizard onComplete={handleSetupComplete} onNavigate={navigate} />;
    
    case 'create-board':
      // While scaffolding, replace the form rather than layering a spinner
      // over it: the form's inputs are inert at that point, and leaving them
      // on screen invites the user to keep typing into a screen that has
      // already moved on.
      if (scaffolding) {
        return (
          <ScreenFrame
            title={['Dashboards', 'Creating']}
            status="Scaffolding project…"
            statusTone="busy"
            /* No hints: no key does anything until this finishes. */
            hints={[]}
          >
            <Box marginTop={1}>
              <Spinner label="Copying the dashboard template and writing configuration…" />
            </Box>
          </ScreenFrame>
        );
      }
      return (
        <Box flexDirection="column">
          {scaffoldError && (
            <Box padding={1}>
              <Text color="red">Scaffold error: {scaffoldError}</Text>
            </Box>
          )}
          <BoardCreationScreen onNavigate={navigate} onBoardCreated={handleBoardCreated} />
        </Box>
      );

    case 'manage-boards':
      return (
        <ManageBoardsScreen
          onNavigate={navigate}
          onBoardSelected={handleBoardSelected}
          onModifyAll={handleModifyAll}
        />
      );

    case 'chat':
      return (
        <ChatScreen
          board={currentBoard}
          onNavigate={navigate}
          autoGenerateInitial={shouldAutoGenerate}
          allBoards={allBoardsMode}
          billerStatus={billerStatus}
        />
      );
    
    case 'settings':
      return <SettingsPlaceholder onNavigate={navigate} />;

    case 'settings-mode':
      return <AppModeSettings onNavigate={navigate} />;

    case 'settings-vercel':
      return <VercelTokenSettings onNavigate={navigate} />;

    case 'settings-github':
      return <GitHubTokenSettings onNavigate={navigate} />;

    case 'settings-llm':
      return <LLMSettings onNavigate={navigate} />;

    case 'settings-dashboard-auth':
      return <DashboardAuthSettings onNavigate={navigate} />;

    case 'integrations':
      return <IntegrationsScreen onNavigate={navigate} />;

    case 'integrations-gmail':
      return (
        <GmailIntegrationScreen
          onNavigate={navigate}
          onBillersConfigured={() => setBillerConfigVersion((n) => n + 1)}
        />
      );

    case 'biller-studio':
      return (
        <BillerStudioScreen
          onNavigate={navigate}
          onBillerCreated={() => setBillerConfigVersion((n) => n + 1)}
        />
      );

    case 'deploy':
      return <DeployPlaceholder onNavigate={navigate} />;
    
    default:
      return <WelcomeScreen onNavigate={navigate} />;
  }
}
