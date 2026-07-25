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

type Step = 'menu' | 'client-id' | 'client-secret' | 'query' | 'interval';

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
    setStatus('OAuth client saved. Select "Connect Google account" to finish.');
    setStep('menu');
    refresh();
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { email } = await auth.connectInteractive((line) => setStatus(line));
      setStatus(`Connected as ${email}. Background sync starts automatically.`);
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
        ? `Synced ${result.fetched} message(s) — ${result.totalCached} cached.`
        : `Sync failed: ${result.error}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await auth.disconnect();
      setStatus('Gmail disconnected. Cached messages remain on disk.');
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
    setStatus(`Sync interval set to ${minutes} min. Takes effect next launch or reconnect.`);
    setIntervalInput('');
    setStep('menu');
    refresh();
  };

  const saveQuery = (value: string) => {
    const trimmed = value.trim();
    const config = new ConfigService();
    if (trimmed) config.set('gmail.query', trimmed);
    else config.delete('gmail.query');
    setStatus(trimmed ? `Sync query set to "${trimmed}".` : 'Sync query reset to default (in:inbox).');
    setQueryInput('');
    setStep('menu');
    refresh();
  };

  const menuItems = [
    { label: authStatus.connected || auth.hasCredentials() ? 'Re-enter OAuth client (ID + secret)' : 'Enter OAuth client (ID + secret)', value: 'credentials' },
    ...(auth.hasCredentials()
      ? [{ label: authStatus.connected ? 'Reconnect Google account' : 'Connect Google account', value: 'connect' }]
      : []),
    ...(authStatus.connected
      ? [
          { label: 'Sync now', value: 'sync' },
          { label: `Sync query (current: ${settings.query})`, value: 'query' },
          { label: `Sync interval (current: ${settings.syncIntervalMinutes} min)`, value: 'interval' },
          { label: 'Disconnect', value: 'disconnect' },
        ]
      : []),
    { label: '← Go Back', value: 'back' },
  ];

  const handleMenuSelect = (item: { value: string }) => {
    if (busy) return;
    setStatus('');
    if (item.value === 'credentials') setStep('client-id');
    else if (item.value === 'connect') void connect();
    else if (item.value === 'sync') void syncNow();
    else if (item.value === 'query') { setQueryInput(settings.query); setStep('query'); }
    else if (item.value === 'interval') { setIntervalInput(String(settings.syncIntervalMinutes)); setStep('interval'); }
    else if (item.value === 'disconnect') void disconnect();
    else onNavigate('settings');
  };

  const connectionLine = authStatus.needsReauth
    ? 'Status: re-auth needed — reconnect your Google account'
    : authStatus.connected
      ? `Status: connected as ${authStatus.email ?? 'unknown'}`
      : auth.hasCredentials()
        ? 'Status: OAuth client saved, account not connected yet'
        : 'Status: not configured';

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>✉ Gmail Integration</Text>
      <Text color={UI_COLORS.subtitle}>
        Sync your inbox into a local cache and use it as dashboard data.
        Needs a Google Cloud OAuth "Desktop app" client (scope: gmail.readonly).
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={authStatus.needsReauth ? 'yellow' : UI_COLORS.subtitle}>{connectionLine}</Text>
        {syncState.lastSyncAt && (
          <Text color={UI_COLORS.subtitle}>
            Last sync: {new Date(syncState.lastSyncAt).toLocaleString()} · {syncState.totalCached ?? 0} cached
          </Text>
        )}
        {authStatus.connected && (
          <Text color={UI_COLORS.subtitle}>Cache: {MailCacheService.getCachePath()}</Text>
        )}
      </Box>

      {step === 'client-id' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Client ID › </Text>
          <TextInput
            value={clientId}
            onChange={setClientId}
            onSubmit={(value) => { if (value.trim()) setStep('client-secret'); }}
            placeholder="xxxx.apps.googleusercontent.com"
          />
        </Box>
      )}
      {step === 'client-secret' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Client secret › </Text>
          <TextInput
            value={clientSecret}
            onChange={setClientSecret}
            onSubmit={(value) => { if (value.trim()) saveCredentials(value); }}
            mask="*"
            placeholder="GOCSPX-..."
          />
        </Box>
      )}
      {step === 'query' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Gmail query › </Text>
          <TextInput
            value={queryInput}
            onChange={setQueryInput}
            onSubmit={saveQuery}
            placeholder="in:inbox (empty resets to default)"
          />
        </Box>
      )}
      {step === 'interval' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Interval (minutes) › </Text>
          <TextInput
            value={intervalInput}
            onChange={setIntervalInput}
            onSubmit={saveInterval}
            placeholder="5"
          />
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
          Privacy: mail is cached only on this machine; it leaves it only if you deploy a mail-backed dashboard in remote mode.
        </Text>
        <Text color={UI_COLORS.subtitle}>Press ESC to go back</Text>
      </Box>
    </Box>
  );
}
