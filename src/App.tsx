import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { WelcomeScreen } from './screens/WelcomeScreen.js';
import { SetupWizard } from './screens/SetupWizard.js';
import { BoardCreationScreen } from './screens/BoardCreationScreen.js';
import { ChatScreen } from './screens/ChatScreen.js';
import { ManageBoardsScreen } from './screens/ManageBoardsScreen.js';
import { ProjectManager } from './services/project/ProjectManager.js';
import { ConfigService } from './services/config/ConfigService.js';
import { LLMService } from './services/llm/LLMService.js';
import { OpenAICodexProvider } from './services/llm/OpenAICodexProvider.js';
import { GitHubService } from './services/deploy/GitHubService.js';
import { VercelService } from './services/deploy/VercelService.js';
import { AuthService } from './services/auth/AuthService.js';
import type { LLMConfig } from './types/llm.js';
import type { BoardConfig } from './types/board.js';
import { UI_COLORS } from './theme.js';

const projectManager = new ProjectManager();

export type Screen =
  | 'welcome'
  | 'setup'
  | 'create-board'
  | 'manage-boards'
  | 'chat'
  | 'deploy'
  | 'settings'
  | 'settings-vercel'
  | 'settings-github'
  | 'settings-llm'
  | 'settings-dashboard-auth';

// Placeholder components with "Go Back" option
function SettingsPlaceholder({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  useInput((input, key) => {
    if (key.escape) onNavigate('welcome');
  });

  const items = [
    { label: 'Update LLM provider', value: 'llm' },
    { label: 'Re-enter GitHub token', value: 'github' },
    { label: 'Re-enter Vercel token', value: 'vercel' },
    { label: 'Reset dashboard login', value: 'dashboard-auth' },
    { label: 'Run full setup wizard', value: 'setup' },
    { label: '← Go Back', value: 'back' },
  ];

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>⚙️ Settings</Text>
      <Text color={UI_COLORS.subtitle}>Update credentials used by OpenBoard.</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === 'llm') onNavigate('settings-llm');
            else if (item.value === 'github') onNavigate('settings-github');
            else if (item.value === 'vercel') onNavigate('settings-vercel');
            else if (item.value === 'dashboard-auth') onNavigate('settings-dashboard-auth');
            else if (item.value === 'setup') onNavigate('setup');
            else onNavigate('welcome');
          }}
        />
      </Box>
      <Text color={UI_COLORS.subtitle}>Press ESC or select Go Back</Text>
    </Box>
  );
}

function DashboardAuthSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [step, setStep] = useState<'username' | 'password'>('username');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useInput((input, key) => {
    if (key.escape) onNavigate('settings');
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
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>Dashboard Login</Text>
      <Text color={UI_COLORS.subtitle}>Set the username and password used by the deployed dashboard.</Text>
      {step === 'username' ? (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Username › </Text>
          <TextInput
            value={username}
            onChange={setUsername}
            onSubmit={() => setStep('password')}
            placeholder="admin"
          />
        </Box>
      ) : (
        <Box marginTop={1}>
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
      {status && (
        <Box marginTop={1}>
          <Text color={status.includes('saved') ? 'green' : saving ? 'yellow' : 'red'}>{status}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>Press Enter to continue/save · ESC to go back</Text>
      </Box>
    </Box>
  );
}

function GitHubTokenSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useInput((input, key) => {
    if (key.escape) onNavigate('settings');
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
          'User-Agent': 'OpenBoard-TUI',
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
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>GitHub Token</Text>
      <Text color={UI_COLORS.subtitle}>Paste a GitHub token with repo scope. It will be validated and encrypted locally.</Text>
      <Box marginTop={1}>
        <Text color={UI_COLORS.logo}>Token › </Text>
        <TextInput
          value={token}
          onChange={setToken}
          onSubmit={saveToken}
          mask="*"
          placeholder="ghp_... or github_pat_..."
        />
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color={status.includes('saved') || status.includes('success') ? 'green' : saving ? 'yellow' : 'red'}>{status}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>Press Enter to save · ESC to go back</Text>
      </Box>
    </Box>
  );
}

type LLMProviderName = 'openai' | 'openai-codex' | 'anthropic' | 'moonshot' | 'ollama';
type LLMSettingsStep = 'provider' | 'apiKey' | 'model' | 'ollamaHost' | 'saving';

const LLM_PROVIDER_ITEMS: Array<{ label: string; value: LLMProviderName | 'back' }> = [
  { label: 'OpenAI API Key', value: 'openai' },
  { label: '(Recommended) OpenAI Codex / ChatGPT subscription', value: 'openai-codex' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Moonshot AI', value: 'moonshot' },
  { label: 'Ollama', value: 'ollama' },
  { label: '← Go Back', value: 'back' },
];

const DEFAULT_LLM_MODELS: Record<LLMProviderName, string> = {
  openai: 'gpt-4o',
  'openai-codex': 'gpt-5.5',
  anthropic: 'claude-sonnet-4-5',
  moonshot: 'moonshot-v1-128k',
  ollama: 'qwen2.5-coder:7b',
};

function LLMSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [step, setStep] = useState<LLMSettingsStep>('provider');
  const [provider, setProvider] = useState<LLMProviderName>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434');
  const [status, setStatus] = useState('');

  useInput((input, key) => {
    if (key.escape) onNavigate('settings');
  });

  const saveLLM = async () => {
    setStep('saving');
    setStatus('Validating LLM settings...');
    try {
      const selectedModel = model.trim() || DEFAULT_LLM_MODELS[provider];

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
      };

      if (provider !== 'ollama' && !configToValidate.apiKey) {
        setStatus('API key is required for this provider.');
        setStep('apiKey');
        return;
      }

      const llm = LLMService.createProvider(configToValidate);
      const validation = await llm.validate();
      if (!validation.valid) {
        setStatus(validation.error ?? 'LLM validation failed.');
        setStep(provider === 'ollama' ? 'ollamaHost' : 'apiKey');
        return;
      }

      const config = new ConfigService();
      config.set('llm.provider', provider);
      config.set('llm.model', selectedModel);
      if (provider === 'ollama') {
        config.set('llm.ollamaHost', ollamaHost.trim());
      } else if (apiKey.trim()) {
        config.setEncrypted('llm.apiKey', apiKey.trim());
      }
      setStatus('LLM settings saved.');
      setApiKey('');
      setStep('provider');
    } catch (error: any) {
      setStatus(`Could not save LLM settings: ${error.message}`);
      setStep(provider === 'ollama' ? 'ollamaHost' : provider === 'openai-codex' ? 'provider' : 'apiKey');
    }
  };

  if (step === 'provider') {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold color={UI_COLORS.logo}>LLM Provider</Text>
        <Text color={UI_COLORS.subtitle}>Choose the provider to configure.</Text>
        {status && (
          <Box marginTop={1}>
            <Text color={status.includes('saved') ? 'green' : 'yellow'}>{status}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={LLM_PROVIDER_ITEMS}
            onSelect={(item) => {
              if (item.value === 'back') {
                onNavigate('settings');
                return;
              }
              setProvider(item.value);
              setModel(DEFAULT_LLM_MODELS[item.value]);
              setStep(item.value === 'ollama' ? 'ollamaHost' : item.value === 'openai-codex' ? 'model' : 'apiKey');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === 'apiKey') {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold color={UI_COLORS.logo}>{provider} API Key</Text>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>API key › </Text>
          <TextInput value={apiKey} onChange={setApiKey} onSubmit={() => setStep('model')} mask="*" placeholder="sk-..." />
        </Box>
        {status && <Text color="red">{status}</Text>}
        <Text color={UI_COLORS.subtitle}>Press Enter to continue · ESC to go back</Text>
      </Box>
    );
  }

  if (step === 'ollamaHost') {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold color={UI_COLORS.logo}>Ollama Host</Text>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Host › </Text>
          <TextInput value={ollamaHost} onChange={setOllamaHost} onSubmit={() => setStep('model')} placeholder="http://127.0.0.1:11434" />
        </Box>
        {status && <Text color="red">{status}</Text>}
        <Text color={UI_COLORS.subtitle}>Press Enter to continue · ESC to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>LLM Model</Text>
      <Text color={UI_COLORS.subtitle}>Provider: {provider}</Text>
      <Box marginTop={1}>
        <Text color={UI_COLORS.logo}>Model › </Text>
        <TextInput value={model} onChange={setModel} onSubmit={saveLLM} placeholder={DEFAULT_LLM_MODELS[provider]} />
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color={status.includes('saved') ? 'green' : step === 'saving' ? 'yellow' : 'red'}>{status}</Text>
        </Box>
      )}
      <Text color={UI_COLORS.subtitle}>Press Enter to validate/save · ESC to go back</Text>
    </Box>
  );
}

function VercelTokenSettings({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useInput((input, key) => {
    if (key.escape) onNavigate('settings');
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
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>Vercel Token</Text>
      <Text color={UI_COLORS.subtitle}>Paste a Vercel API token. It will be validated and encrypted locally.</Text>
      <Box marginTop={1}>
        <Text color={UI_COLORS.logo}>Token › </Text>
        <TextInput
          value={token}
          onChange={setToken}
          onSubmit={saveToken}
          mask="*"
          placeholder="vercel token..."
        />
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color={status.includes('saved') ? 'green' : saving ? 'yellow' : 'red'}>{status}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>Press Enter to save · ESC to go back</Text>
      </Box>
    </Box>
  );
}

function DeployPlaceholder({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  useInput((input, key) => {
    if (key.escape) onNavigate('welcome');
  });

  const items = [{ label: '← Go Back', value: 'back' }];

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>🚀 Deploy</Text>
      <Text color={UI_COLORS.subtitle}>Deploy screen - Coming soon</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={() => onNavigate('welcome')} />
      </Box>
      <Text color={UI_COLORS.subtitle}>Press ESC or select Go Back</Text>
    </Box>
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
  const [screen, setScreen] = useState<Screen>('welcome');
  const [currentBoard, setCurrentBoard] = useState<BoardConfig>(defaultBoard);
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false);
  const [allBoardsMode, setAllBoardsMode] = useState(false);
  const [scaffoldError, setScaffoldError] = useState<string | null>(null);

  const navigate = (s: Screen) => setScreen(s);

  const handleSetupComplete = () => {
    navigate('manage-boards');
  };

  const handleBoardCreated = useCallback(async (board: BoardConfig) => {
    setScaffoldError(null);
    const result = await projectManager.scaffold(board);
    if (result.success) {
      setCurrentBoard(result.board);
      setShouldAutoGenerate(true);
      setAllBoardsMode(false);
      navigate('chat');
    } else {
      setScaffoldError(result.error || 'Failed to scaffold project');
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
        />
      );
    
    case 'settings':
      return <SettingsPlaceholder onNavigate={navigate} />;

    case 'settings-vercel':
      return <VercelTokenSettings onNavigate={navigate} />;

    case 'settings-github':
      return <GitHubTokenSettings onNavigate={navigate} />;

    case 'settings-llm':
      return <LLMSettings onNavigate={navigate} />;

    case 'settings-dashboard-auth':
      return <DashboardAuthSettings onNavigate={navigate} />;
    
    case 'deploy':
      return <DeployPlaceholder onNavigate={navigate} />;
    
    default: 
      return <WelcomeScreen onNavigate={navigate} />;
  }
}
