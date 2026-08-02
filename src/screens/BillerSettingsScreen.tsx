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
  discoverBillers,
  stalePronedDataKeys,
  installBundledScripts,
  validateScriptsDir,
} from '../services/billers/BillerDiscoveryService.js';
import { BillerFetcherService } from '../services/billers/BillerFetcherService.js';
import {
  isBillerSyncConfigured,
  msUntilDue,
  recordBillerRun,
  shouldAnchorRun,
} from '../services/billers/billerScheduler.js';
import { defaultScriptsDir } from '../types/billers.js';
import { LogPane } from '../components/LogPane.js';
import { useProgressLog } from '../hooks/useProgressLog.js';
import { billerActivityLog } from '../services/billers/billerActivityLog.js';

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

/** Menu rows that flip a biller on or off carry their key behind this prefix. */
const TOGGLE_PREFIX = 'toggle:';

/**
 * The biller a menu row toggles, or undefined for any other row.
 *
 * Both Enter and Space act on these rows, and the offset used to be a bare
 * `slice(7)` at the Enter site — a magic number that silently decodes the
 * wrong key the moment the prefix changes.
 */
export function billerKeyForToggle(menuValue: string): string | undefined {
  return menuValue.startsWith(TOGGLE_PREFIX) ? menuValue.slice(TOGGLE_PREFIX.length) : undefined;
}

/** "in 4 min" / "in 2h 10m", or "due now" once the interval has elapsed. */
function describeNextRun(msRemaining: number): string {
  if (msRemaining <= 0) return 'due now';
  const totalMinutes = Math.ceil(msRemaining / 60_000);
  if (totalMinutes < 60) return `in ${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `in ${hours}h` : `in ${hours}h ${minutes}m`;
}

export function BillerSettingsScreen({ onNavigate, onBillersConfigured }: Props) {
  const [step, setStep] = useState<Step>('menu');
  const [dirInput, setDirInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [intervalInput, setIntervalInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setRefresh] = useState(0);
  /** Value of the row the cursor is on, so space can act on it. */
  const [highlighted, setHighlighted] = useState('');

  // Bound to the shared activity log, not local state: scheduled fetches run
  // with no screen mounted, so their output has to survive until someone opens
  // this screen. "Fetch now" writes to the same log.
  // `status` stays for short inline form validation next to the input.
  const log = useProgressLog({ store: billerActivityLog });

  useInput((input, key) => {
    if (key.escape && !busy) {
      if (step === 'menu') onNavigate('settings');
      else setStep('menu');
    }

    // Space toggles the highlighted biller. ink-select-input binds only
    // arrows/j/k and Enter, so space did nothing at all — the row looked
    // interactive and silently ignored the most obvious key for a checkbox.
    //
    // Menu only: the folder and address steps need space as a literal
    // character, and `busy` keeps it from firing mid-fetch.
    if (input === ' ' && step === 'menu' && !busy) {
      const key = billerKeyForToggle(highlighted);
      if (key) {
        toggleBiller(key);
        return;
      }
    }

    // PgUp/PgDn scroll the log without disturbing the menu's arrow keys.
    log.onKey(key);
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
    // Nothing is written to disk for the fetchers any more — the password is
    // handed to each one through its environment at run time. Clear the
    // plaintext file an older version may have left behind.
    const removed = new BillerFetcherService().removeLegacyCredentialsFile();
    setStatus(
      removed
        ? 'App Password saved (encrypted). Removed the old plaintext credentials file left by a previous version.'
        : 'App Password saved (encrypted). It is passed to the fetchers at run time and never written to disk.',
    );
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
    setStatus(`Fetch interval set to ${minutes} min (${(minutes / 60).toFixed(1)}h). The next run is now scheduled from the last fetch.`);
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
    setStatus('');
    log.append('Running enabled invoice fetchers…');
    try {
      // No truncation: the pane wraps, so a long fetcher line stays readable
      // instead of being cut at 120 characters.
      const results = await new BillerFetcherService().syncEnabled({
        onProgress: log.append,
      });
      if (results.skipped === 'locked') return;
      if (results.length === 0) {
        // Distinguish "none switched on" from "the folder went missing".
        log.append(billers.length === 0
          ? `No biller scripts found in ${settings.scriptsDir}. Check the folder still exists, then use "Rescan billers folder".`
          : 'No billers are enabled yet — switch one on in the list above.');
        return;
      }
      // A manual fetch is the same work a scheduled tick does, so a real run
      // re-anchors the schedule. Without this the restart below still saw the
      // old lastRunAt, judged the loop overdue, and fetched everything again.
      if (shouldAnchorRun(results)) recordBillerRun();

      const failed = results.filter((r) => !r.ok);
      const updated = results.filter((r) => r.changed);
      log.append(failed.length > 0
        ? `Failed: ${failed.map((r) => `${r.displayName} (${r.error})`).join(' · ')}`
        : updated.length > 0
          ? `Fetched new invoices for ${updated.map((r) => r.displayName).join(', ')}; dashboards refreshed.`
          : `Ran ${results.length} fetcher(s) — no new invoices found.`);
    } catch (error: any) {
      log.append(`Sync failed: ${error.message}`);
    } finally {
      setBusy(false);
      // Refresh the screen and restart the scheduler either way. When nothing
      // was anchored above the restart re-arms from the unchanged lastRunAt, so
      // the pending run keeps its original time.
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
            value: `${TOGGLE_PREFIX}${biller.key}`,
          })),
          // Sits directly under the list it adds to, the way ManageBoardsScreen
          // puts "Add new dashboard" beside the dashboards.
          { label: '✚ Add a new biller (Biller Studio)', value: 'add-biller' },
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
    const toggleKey = billerKeyForToggle(item.value);
    if (toggleKey) { toggleBiller(toggleKey); return; }
    if (item.value === 'install') { installBundled(); return; }
    // Pre-fill the canonical location so the common case is just Enter.
    if (item.value === 'dir') { setDirInput(settings.scriptsDir ?? defaultScriptsDir()); setStep('scripts-dir'); }
    else if (item.value === 'email') { setEmailInput(settings.email ?? ''); setStep('email'); }
    else if (item.value === 'password') setStep('app-password');
    else if (item.value === 'interval') { setIntervalInput(String(settings.syncIntervalMinutes)); setStep('interval'); }
    else if (item.value === 'add-biller') onNavigate('biller-studio');
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

  // Data with no fetcher behind it renders a dashboard that quietly stops
  // updating, which looks identical to one that is simply up to date.
  const stale = hasDir ? stalePronedDataKeys(settings.scriptsDir) : [];

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
        {/*
          Derived from the same lastRunAt anchor the scheduler uses, so it needs
          no status plumbing into this screen. The loop only runs while OpenBoard
          is open, which the wording has to be honest about.
        */}
        {isBillerSyncConfigured(settings) && (
          <Text color={UI_COLORS.subtitle}>
            Next run: {describeNextRun(msUntilDue(settings))} (while OpenBoard is open)
          </Text>
        )}
        {hasDir && (
          <Text color={UI_COLORS.subtitle}>Credentials: encrypted in config, passed to fetchers at run time</Text>
        )}
        {stale.length > 0 && (
          <Text color="yellow">
            No fetcher for: {stale.join(', ')} — these dashboards will not refresh. Add one with ✚ Add a new biller.
          </Text>
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
          <SelectInput
            items={menuItems}
            onSelect={handleMenuSelect}
            onHighlight={(item) => setHighlighted(item.value)}
          />
        </Box>
      )}

      {status && (
        <Box marginTop={1}>
          <Text color={busy ? 'yellow' : /fail|error|not |cannot|must be|missing/i.test(status) ? 'red' : 'green'}>{status}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={UI_COLORS.subtitle}>
          The fetchers read Gmail over IMAP. Your App Password is stored encrypted and handed
          to each fetcher through its environment at run time — it is never written to disk.
          An App Password grants full mailbox read access, so revoke it in your Google account
          to cut access off. Fetchers need Python 3 with beautifulsoup4 installed.
        </Text>
        <Text color={UI_COLORS.subtitle}>Space or Enter toggles the highlighted biller · PgUp/PgDn scroll the log · ESC goes back</Text>
        <Text color={UI_COLORS.subtitle}>Fetching runs only while OpenBoard is open.</Text>
      </Box>

      {/* Last child: progress belongs below every option, never above them. */}
      <LogPane view={log.view} title="Fetch log" />
    </Box>
  );
}
