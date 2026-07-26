import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { existsSync } from 'node:fs';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { TypedConfigRepository } from '../services/config/TypedConfigRepository.js';
import { normalizeUserPath } from '../utils/pathNormalizer.js';
import {
  credentialsPathFor,
  discoverBillers,
  installBundledScripts,
  validateScriptsDir,
} from '../services/billers/BillerDiscoveryService.js';
import { BillerFetcherService } from '../services/billers/BillerFetcherService.js';
import { defaultScriptsDir } from '../types/billers.js';

interface Props {
  onNavigate: (s: Screen) => void;
  /** Called after any change that affects the scheduler so App re-arms it. */
  onBillersConfigured?: () => void;
}

// Deliberate order: the folder has to exist before anything can be listed, then
// the account, then its credential. Asking for the email before the password
// (rather than after, as the OAuth screen effectively does) was an explicit
// request — you should know which account you are authorizing before typing a
// secret for it.
type Step = 'menu' | 'scripts-dir' | 'email' | 'app-password' | 'interval';

export function BillerSettingsScreen({ onNavigate, onBillersConfigured }: Props) {
  const [step, setStep] = useState<Step>('menu');
  const [dirInput, setDirInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [intervalInput, setIntervalInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setRefresh] = useState(0);

  useInput((_input, key) => {
    if (key.escape && !busy) {
      if (step === 'menu') onNavigate('settings');
      else setStep('menu');
    }
  });

  const config = new ConfigService();
  const settings = new TypedConfigRepository().getBillerSettings();
  const billers = discoverBillers(settings.scriptsDir);
  const hasDir = Boolean(settings.scriptsDir);
  const hasEmail = Boolean(settings.email);
  const hasPassword = Boolean(settings.appPassword);

  const refresh = () => setRefresh((n) => n + 1);
  const changed = () => { refresh(); onBillersConfigured?.(); };

  const saveScriptsDir = (value: string) => {
    const path = normalizeUserPath(value);
    if (!path) return;
    const result = validateScriptsDir(path);
    if (!result.valid) {
      setStatus(result.error ?? 'That folder cannot be used.');
      return;
    }
    config.set('billers.scriptsDir', path);
    setStatus(`Found ${result.billers.length} biller fetcher(s). Next: add the Gmail address they log in as.`);
    setDirInput('');
    setStep('menu');
    changed();
  };

  const saveEmail = (value: string) => {
    const email = value.trim();
    if (!email.includes('@')) {
      setStatus('Enter a full Gmail address, e.g. you@gmail.com.');
      return;
    }
    config.set('billers.email', email);
    setStatus(`Gmail address saved. Next: add the App Password for ${email}.`);
    setEmailInput('');
    setStep('menu');
    changed();
  };

  const savePassword = (value: string) => {
    // Google displays App Passwords in four spaced groups; users paste them that way.
    const password = value.replace(/\s+/g, '');
    if (password.length < 16) {
      setStatus('An App Password is 16 characters. This is not your normal Gmail password.');
      return;
    }
    config.setEncrypted('billers.appPassword', password);
    setPasswordInput('');
    try {
      const written = new BillerFetcherService().writeCredentialsFile();
      setStatus(`App Password saved. Credentials written for the fetchers: ${written}`);
    } catch (error: any) {
      setStatus(`App Password saved, but the credentials file could not be written: ${error.message}`);
    }
    setStep('menu');
    changed();
  };

  const saveInterval = (value: string) => {
    const minutes = Number(value.trim());
    if (!Number.isInteger(minutes) || minutes < 1) {
      setStatus('Interval must be a whole number of minutes (min 1).');
      return;
    }
    config.set('billers.syncIntervalMinutes', minutes);
    setStatus(`Fetch interval set to ${minutes} min (${(minutes / 60).toFixed(1)}h). Applied on the next launch or after a toggle.`);
    setIntervalInput('');
    setStep('menu');
    changed();
  };

  const toggleBiller = (key: string) => {
    const enabled = new Set(settings.enabledKeys);
    if (enabled.has(key)) enabled.delete(key);
    else enabled.add(key);
    config.set('billers.enabledKeys', [...enabled]);
    setStatus(enabled.has(key) ? `Enabled ${key}.` : `Disabled ${key}.`);
    changed();
  };

  const syncNow = async () => {
    setBusy(true);
    setStatus('Running enabled invoice fetchers…');
    try {
      const results = await new BillerFetcherService().syncEnabled({
        onProgress: (line) => setStatus(line.slice(0, 120)),
      });
      if (results.length === 0) {
        // Distinguish "none switched on" from "the folder went missing".
        setStatus(billers.length === 0
          ? `No biller scripts found in ${settings.scriptsDir}. Check the folder still exists, then use "Rescan billers folder".`
          : 'No billers are enabled yet — switch one on in the list above.');
        return;
      }
      const failed = results.filter((r) => !r.ok);
      const updated = results.filter((r) => r.changed);
      setStatus(failed.length > 0
        ? `Failed: ${failed.map((r) => `${r.displayName} (${r.error})`).join(' · ')}`
        : updated.length > 0
          ? `Fetched new invoices for ${updated.map((r) => r.displayName).join(', ')}; dashboards refreshed.`
          : `Ran ${results.length} fetcher(s) — no new invoices found.`);
    } catch (error: any) {
      setStatus(`Sync failed: ${error.message}`);
    } finally {
      setBusy(false);
      changed();
    }
  };

  const installBundled = () => {
    const target = defaultScriptsDir();
    const result = installBundledScripts(target);
    if (result.error) {
      setStatus(`Could not install the bundled fetchers: ${result.error}`);
      return;
    }
    config.set('billers.scriptsDir', target);
    const kept = result.skipped.length > 0 ? ` (${result.skipped.length} already there, left alone)` : '';
    setStatus(`Installed ${result.installed.length} fetcher(s) to ${target}${kept}. Next: add the Gmail address they log in as.`);
    changed();
  };

  const clearCredentials = () => {
    config.delete('billers.email');
    config.delete('billers.appPassword');
    setStatus('Gmail address and App Password cleared from OpenBoard. The credentials file on disk was left in place — delete it manually if you want it gone.');
    changed();
  };

  const menuItems = [
    // Offered first on a fresh setup: one keypress from nothing to a working
    // folder, instead of hunting for scripts the user may not have yet.
    ...(hasDir ? [] : [{ label: 'Install the fetchers bundled with OpenBoard (recommended)', value: 'install' }]),
    { label: hasDir ? `Invoice scripts folder (current: ${settings.scriptsDir})` : 'Set invoice scripts folder', value: 'dir' },
    ...(hasDir ? [{ label: hasEmail ? `Gmail address (current: ${settings.email})` : 'Set Gmail address', value: 'email' }] : []),
    ...(hasDir && hasEmail
      ? [{ label: hasPassword ? 'Replace Gmail App Password' : 'Set Gmail App Password', value: 'password' }]
      : []),
    // The biller list only makes sense once the account behind it is known.
    ...(hasDir && hasEmail && hasPassword
      ? [
          ...billers.map((biller) => ({
            label: `${settings.enabledKeys.includes(biller.key) ? '[x]' : '[ ]'} ${biller.displayName}${existsSync(biller.csvPath) ? '' : ' (no data yet)'}`,
            value: `toggle:${biller.key}`,
          })),
          { label: `Fetch interval (current: ${settings.syncIntervalMinutes} min)`, value: 'interval' },
          { label: 'Fetch now', value: 'sync' },
          { label: 'Rescan billers folder', value: 'rescan' },
          { label: 'Clear saved credentials', value: 'clear' },
        ]
      : []),
    { label: '← Go Back', value: 'back' },
  ];

  const handleMenuSelect = (item: { value: string }) => {
    if (busy) return;
    setStatus('');
    if (item.value.startsWith('toggle:')) { toggleBiller(item.value.slice(7)); return; }
    if (item.value === 'install') { installBundled(); return; }
    // Pre-fill the canonical location so the common case is just Enter.
    if (item.value === 'dir') { setDirInput(settings.scriptsDir ?? defaultScriptsDir()); setStep('scripts-dir'); }
    else if (item.value === 'email') { setEmailInput(settings.email ?? ''); setStep('email'); }
    else if (item.value === 'password') setStep('app-password');
    else if (item.value === 'interval') { setIntervalInput(String(settings.syncIntervalMinutes)); setStep('interval'); }
    else if (item.value === 'sync') void syncNow();
    else if (item.value === 'rescan') { setStatus(`Found ${discoverBillers(settings.scriptsDir).length} biller fetcher(s).`); refresh(); }
    else if (item.value === 'clear') clearCredentials();
    else onNavigate('settings');
  };

  const setupLine = !hasDir
    ? 'Status: no scripts folder set'
    : !hasEmail
      ? 'Status: folder set — Gmail address needed'
      : !hasPassword
        ? 'Status: address set — App Password needed'
        : settings.enabledKeys.length === 0
          ? `Status: ready — ${billers.length} biller(s) found, none enabled yet`
          : `Status: ${settings.enabledKeys.length} of ${billers.length} biller(s) enabled`;

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>🧾 Invoice Fetchers</Text>
      <Text color={UI_COLORS.subtitle}>
        Run your per-biller invoice scripts on a schedule and turn each biller's
        invoices into its own dashboard.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={UI_COLORS.subtitle}>{setupLine}</Text>
        {settings.lastRunAt && (
          <Text color={UI_COLORS.subtitle}>
            Last run: {new Date(settings.lastRunAt).toLocaleString()}
          </Text>
        )}
        {hasDir && (
          <Text color={UI_COLORS.subtitle}>Credentials file: {credentialsPathFor(settings.scriptsDir!)}</Text>
        )}
      </Box>

      {step === 'scripts-dir' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>Folder holding your fetch_&lt;biller&gt;.py scripts (quotes are fine).</Text>
          <Text color={UI_COLORS.subtitle}>
            Recommended: keep them in OpenBoard's own folder, pre-filled below — your
            invoices and credentials then live alongside it under billers/.
          </Text>
          <Box>
            <Text color={UI_COLORS.logo}>Folder › </Text>
            <TextInput
              value={dirInput}
              onChange={setDirInput}
              onSubmit={saveScriptsDir}
              placeholder="C:\path\to\invoice_fetchers"
            />
          </Box>
        </Box>
      )}
      {step === 'email' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Gmail address › </Text>
          <TextInput
            value={emailInput}
            onChange={setEmailInput}
            onSubmit={saveEmail}
            placeholder="you@gmail.com"
          />
        </Box>
      )}
      {step === 'app-password' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>
            A Google App Password (16 characters) for {settings.email} — create one at
            myaccount.google.com/apppasswords. This is not your normal Gmail password.
          </Text>
          <Box>
            <Text color={UI_COLORS.logo}>App Password › </Text>
            <TextInput
              value={passwordInput}
              onChange={setPasswordInput}
              onSubmit={savePassword}
              mask="*"
              placeholder="abcd efgh ijkl mnop"
            />
          </Box>
        </Box>
      )}
      {step === 'interval' && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Interval (minutes) › </Text>
          <TextInput
            value={intervalInput}
            onChange={setIntervalInput}
            onSubmit={saveInterval}
            placeholder="360"
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
          <Text color={busy ? 'yellow' : /fail|error|not |cannot|must be|missing/i.test(status) ? 'red' : 'green'}>{status}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={UI_COLORS.subtitle}>
          The fetchers read Gmail over IMAP, so they need their credentials in a plain file
          on this machine — protected only as well as the folder it sits in (owner-only
          permissions apply on macOS/Linux; Windows uses the folder's ACLs). An App Password
          grants full mailbox read access — revoke it in your Google account to cut access off.
        </Text>
        <Text color={UI_COLORS.subtitle}>Fetching runs only while OpenBoard is open. Press ESC to go back</Text>
      </Box>
    </Box>
  );
}
