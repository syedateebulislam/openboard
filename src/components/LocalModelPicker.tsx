/**
 * LocalModelPicker — live model picker for local LLM providers (Ollama, LM
 * Studio). Fetches the real installed/loaded models from the endpoint
 * (never a hardcoded/auto-selected default) and lets the user pick one.
 * Falls back to a static suggestion list or free-text entry if the live
 * fetch fails, but never auto-selects on the user's behalf.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { Spinner } from './Spinner.js';
import { UI_COLORS } from '../theme.js';
import {
  fetchInstalledModels,
  type LocalModelChoice,
  type LocalProviderName,
} from '../services/llm/localModelDiscovery.js';

interface LocalModelPickerProps {
  provider: LocalProviderName;
  host: string;
  /** Existing static catalog (MODEL_CHOICES[provider]) — used only as an explicit opt-in fallback. */
  staticChoices: LocalModelChoice[];
  onPick: (model: string) => void;
}

type Mode = 'loading' | 'ready' | 'empty' | 'unreachable' | 'error' | 'static-fallback' | 'manual';

const PROVIDER_LABEL: Record<LocalProviderName, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

export function LocalModelPicker({ provider, host, staticChoices, onPick }: LocalModelPickerProps) {
  const [mode, setMode] = useState<Mode>('loading');
  const [models, setModels] = useState<LocalModelChoice[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [retryNonce, setRetryNonce] = useState(0);
  const label = PROVIDER_LABEL[provider];

  useEffect(() => {
    let cancelled = false;
    setMode('loading');
    fetchInstalledModels(provider, host).then((result) => {
      if (cancelled) return;
      setModels(result.models);
      setMessage(result.message);
      setMode(result.status === 'ok' ? 'ready' : result.status);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, host, retryNonce]);

  if (mode === 'loading') {
    return <Spinner label={`Fetching installed models from ${label}...`} />;
  }

  if (mode === 'ready') {
    return (
      <SelectInput
        items={[...models, { label: '→ Enter a model name manually', value: '__manual__' }]}
        onSelect={(item) => (item.value === '__manual__' ? setMode('manual') : onPick(item.value))}
      />
    );
  }

  if (mode === 'manual') {
    return <ManualModelEntry onSubmit={onPick} />;
  }

  if (mode === 'static-fallback') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Showing suggested {label} models — not verified as installed.</Text>
        <Box marginTop={1}>
          <SelectInput items={staticChoices} onSelect={(item) => onPick(item.value)} />
        </Box>
      </Box>
    );
  }

  // empty | unreachable | error
  return (
    <Box flexDirection="column">
      <Text color="red">{message}</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'Retry', value: '__retry__' },
            { label: 'Enter a model name manually', value: '__manual__' },
            { label: 'Browse suggested models (not verified installed)', value: '__static__' },
          ]}
          onSelect={(item) => {
            if (item.value === '__retry__') setRetryNonce((n) => n + 1);
            else if (item.value === '__manual__') setMode('manual');
            else setMode('static-fallback');
          }}
        />
      </Box>
    </Box>
  );
}

function ManualModelEntry({ onSubmit }: { onSubmit: (model: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text color={UI_COLORS.logo}>Model name › </Text>
      <TextInput value={value} onChange={setValue} onSubmit={(v) => v.trim() && onSubmit(v.trim())} />
    </Box>
  );
}

export default LocalModelPicker;
