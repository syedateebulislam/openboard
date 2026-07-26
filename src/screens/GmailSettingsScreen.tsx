import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { TypedConfigRepository } from '../services/config/TypedConfigRepository.js';
import { GmailAuthService } from '../services/mail/GmailAuthService.js';
import { MailCacheService } from '../services/mail/MailCacheService.js';
import { MailSyncService } from '../services/mail/MailSyncService.js';

interface Props {
  onNavigate: (s: Screen) => void;
  /** Called after connect/disconnect so App re-arms the sync scheduler. */
  onGmailConfigured?: () => void;
}

// 'guide' walks the user through getting the two values from Google before we
// ask for them. Without it the first prompt is a blank field for a term the
// user has never seen — the single worst moment in this whole flow.
type Step = 'menu' | 'guide' | 'client-id' | 'client-secret' | 'query' | 'interval';

export function GmailSettingsScreen({ onNavigate, onGmailConfigured }: Props) {
  const [step, setStep] = useState<Step>('menu');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [intervalInput, setIntervalInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped after connect/disconnect/save so the summary re-reads config.
  const [, setRefresh] = useState(0);

  useInput((_input, key) => {
    if (key.escape && !busy) {
      if (step === 'menu') onNavigate('settings');
      else setStep('menu');
    }
  });

  const auth = new GmailAuthService();
  const authStatus = auth.status();
  const settings = new TypedConfigRepository().getGmailSettings();
  const syncState = new MailCacheService().readSyncState();

  const refresh = () => setRefresh((n) => n + 1);

  const saveCredentials = (secret: string) => {
    const config = new ConfigService();
    config.set('gmail.clientId', clientId.trim());
    config.setEncrypted('gmail.clientSecret', secret.trim());
    setClientSecret('');
    setStatus('Keys saved. Now choose "Step 2 · Sign in with Google" to finish.');
    setStep('menu');
    refresh();
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { email } = await auth.connectInteractive((line) => setStatus(line));
      setStatus(`Connected as ${email}. New mail is picked up automatically from now on.`);
      onGmailConfigured?.();
    } catch (error: any) {
      setStatus(`Connect failed: ${error.message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setStatus('Syncing Gmail…');
    try {
      const result = await new MailSyncService({ auth }).sync();
      setStatus(result.ok
        ? `Got ${result.fetched} new message(s) — ${result.totalCached} saved on this machine.`
        : `Could not check mail: ${result.error}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await auth.disconnect();
      setStatus('Signed out. Mail already saved on this machine stays until you delete it.');
      onGmailConfigured?.();
    } catch (error: any) {
      setStatus(`Disconnect failed: ${error.message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const saveInterval = (value: string) => {
    const minutes = Number(value.trim());
    if (!Number.isInteger(minutes) || minutes < 1) {
      setStatus('Interval must be a whole number of minutes (min 1).');
      return;
    }
    new ConfigService().set('gmail.syncIntervalMinutes', minutes);
    setStatus(`Will check every ${minutes} min. Applies next time you start OpenBoard or sign in again.`);
    setIntervalInput('');
    setStep('menu');
    refresh();
  };

  const saveQuery = (value: string) => {
    const trimmed = value.trim();
    const config = new ConfigService();
    if (trimmed) config.set('gmail.query', trimmed);
    else config.delete('gmail.query');
    setStatus(trimmed ? `Now including mail matching "${trimmed}".` : 'Back to the default (in:inbox).');
    setQueryInput('');
    setStep('menu');
    refresh();
  };

  const menuItems = [
    {
      label: auth.hasCredentials()
        ? 'Step 1 · Replace your Google access keys'
        : 'Step 1 · Get your Google access keys (one-time, ~3 min)',
      value: 'credentials',
    },
    ...(auth.hasCredentials()
      ? [{
          label: authStatus.connected
            ? 'Step 2 · Sign in again / switch account'
            : 'Step 2 · Sign in with Google',
          value: 'connect',
        }]
      : []),
    ...(authStatus.connected
      ? [
          { label: 'Check for new mail now', value: 'sync' },
          { label: `Which mail to include (current: ${settings.query})`, value: 'query' },
          { label: `Check every (current: ${settings.syncIntervalMinutes} min)`, value: 'interval' },
          { label: 'Disconnect this account', value: 'disconnect' },
        ]
      : []),
    { label: '← Go Back', value: 'back' },
  ];

  const handleMenuSelect = (item: { value: string }) => {
    if (busy) return;
    setStatus('');
    if (item.value === 'credentials') setStep('guide');
    else if (item.value === 'connect') void connect();
    else if (item.value === 'sync') void syncNow();
    else if (item.value === 'query') { setQueryInput(settings.query); setStep('query'); }
    else if (item.value === 'interval') { setIntervalInput(String(settings.syncIntervalMinutes)); setStep('interval'); }
    else if (item.value === 'disconnect') void disconnect();
    else onNavigate('settings');
  };

  const connectionLine = authStatus.needsReauth
    ? 'Status: Google signed you out — run Step 2 again to reconnect'
    : authStatus.connected
      ? `Status: connected as ${authStatus.email ?? 'unknown'}`
      : auth.hasCredentials()
        ? 'Status: keys saved — now do Step 2 to sign in'
        : 'Status: not set up yet — start with Step 1';

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>✉ Connect Gmail</Text>
      <Text color={UI_COLORS.subtitle}>
        Turn your inbox into dashboard data. OpenBoard only ever reads your mail —
        it cannot send, delete, or change anything.
      </Text>
      <Text color={UI_COLORS.subtitle}>
        Google will not let any program read your mail until you register it once.
        That is Step 1; it takes about 3 minutes and never has to be repeated.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={authStatus.needsReauth ? 'yellow' : UI_COLORS.subtitle}>{connectionLine}</Text>
        {syncState.lastSyncAt && (
          <Text color={UI_COLORS.subtitle}>
            Last checked: {new Date(syncState.lastSyncAt).toLocaleString()} · {syncState.totalCached ?? 0} messages saved
          </Text>
        )}
        {authStatus.connected && (
          <Text color={UI_COLORS.subtitle}>Saved to: {MailCacheService.getCachePath()}</Text>
        )}
      </Box>

      {step === 'guide' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={UI_COLORS.logo}>Getting your two access keys from Google</Text>
          <Text color={UI_COLORS.subtitle}>Do this once in your browser, then come back here.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>  1. Go to  console.cloud.google.com/apis/credentials</Text>
            <Text>  2. Create a project if you have none (any name works)</Text>
            <Text>  3. Switch on Gmail access for it:</Text>
            <Text color={UI_COLORS.subtitle}>       console.cloud.google.com/apis/library/gmail.googleapis.com</Text>
            <Text>       then press Enable</Text>
            <Text>  4. Back on the Credentials page, press</Text>
            <Text>       "Create credentials" → "OAuth client ID"</Text>
            <Text>  5. For application type choose <Text bold>Desktop app</Text>, then Create</Text>
            <Text>  6. Google shows you two values — keep that window open</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={UI_COLORS.subtitle}>
              Google labels them "Client ID" and "Client secret". You will paste them next.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={UI_COLORS.logo}>Press Enter when you have them › </Text>
            <TextInput value="" onChange={() => {}} onSubmit={() => setStep('client-id')} />
          </Box>
        </Box>
      )}
      {step === 'client-id' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>
            Paste the first value — the long one ending in .apps.googleusercontent.com
          </Text>
          <Box>
            <Text color={UI_COLORS.logo}>Client ID › </Text>
            <TextInput
              value={clientId}
              onChange={setClientId}
              onSubmit={(value) => { if (value.trim()) setStep('client-secret'); }}
              placeholder="xxxx.apps.googleusercontent.com"
            />
          </Box>
        </Box>
      )}
      {step === 'client-secret' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>
            Now the second value — the shorter one starting with GOCSPX-
          </Text>
          <Box>
            <Text color={UI_COLORS.logo}>Client secret › </Text>
            <TextInput
              value={clientSecret}
              onChange={setClientSecret}
              onSubmit={(value) => { if (value.trim()) saveCredentials(value); }}
              mask="*"
              placeholder="GOCSPX-..."
            />
          </Box>
        </Box>
      )}
      {step === 'query' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>
            Same search box syntax as Gmail itself — e.g. in:inbox, or
            from:amazon.in, or newer_than:90d. Leave empty for your whole inbox.
          </Text>
          <Box>
            <Text color={UI_COLORS.logo}>Include mail matching › </Text>
            <TextInput
              value={queryInput}
              onChange={setQueryInput}
              onSubmit={saveQuery}
              placeholder="in:inbox (empty resets to default)"
            />
          </Box>
        </Box>
      )}
      {step === 'interval' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>How often to check for new mail, in minutes.</Text>
          <Box>
            <Text color={UI_COLORS.logo}>Check every (minutes) › </Text>
            <TextInput
              value={intervalInput}
              onChange={setIntervalInput}
              onSubmit={saveInterval}
              placeholder="5"
            />
          </Box>
        </Box>
      )}
      {step === 'menu' && (
        <Box marginTop={1}>
          <SelectInput items={menuItems} onSelect={handleMenuSelect} />
        </Box>
      )}

      {status && (
        <Box marginTop={1}>
          <Text color={busy ? 'yellow' : status.match(/failed|invalid|must be/i) ? 'red' : 'green'}>{status}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={UI_COLORS.subtitle}>
          Your mail is saved only on this computer. It leaves it only if you deploy a
          dashboard built from it while in All remote mode.
        </Text>
        <Text color={UI_COLORS.subtitle}>
          In Step 2 you pick which Google account to connect, on Google's own sign-in page.
        </Text>
        <Text color={UI_COLORS.subtitle}>Press ESC to go back</Text>
      </Box>
    </Box>
  );
}
