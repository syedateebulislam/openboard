/**
 * GmailIntegrationScreen — invoice fetching, under Integrations › Gmail.
 *
 * Was "Invoice Fetchers" under Settings. Reading invoices out of a mailbox is
 * how data gets into OpenBoard, not a preference about how it behaves, so it
 * belongs beside the other sources rather than beneath the credentials.
 *
 * The screen used to spend twelve lines before its first option: a title, a
 * two-line subtitle, up to five stacked status lines and a four-line security
 * paragraph — on a screen that also has to fit a log pane. The facts are now
 * one meta line, and the prose is shown for the row it actually describes.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { existsSync } from 'node:fs';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { ScreenFrame } from '../components/ScreenFrame.js';
import { parentOf } from '../config/navigation.js';
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
} from '../services/billers/billerScheduler.js';
import {
  activeBillerRun,
  beginBillerRun,
  endBillerRun,
  stopBillerRun,
} from '../services/billers/billerRunController.js';
import { summariseFailures } from '../utils/summariseFailures.js';
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

/**
 * What each row does, shown one line at a time for the highlighted row.
 *
 * This is where the security paragraph went. It was true and worth saying, but
 * saying it permanently above the options meant it was read once and then
 * became four lines of noise; attached to the App Password row it lands at the
 * moment it matters.
 */
const ROW_DETAIL: Record<string, string> = {
  install: 'Copies the fetchers shipped with OpenBoard into its own folder.',
  dir: 'Folder holding your fetch_<biller>.py scripts.',
  email: 'The Gmail account the fetchers sign in as.',
  password: 'A 16-character Google App Password, not your Gmail password. Encrypted, and passed to fetchers at run time — never written to disk.',
  'add-biller': 'Describe one sample email and OpenBoard writes the fetcher for it.',
  interval: 'How often enabled fetchers run, while OpenBoard is open.',
  sync: 'Run every enabled fetcher now.',
  stop: 'Stop the fetch in progress. Billers already done are kept, and the schedule stays anchored.',
  rescan: 'Re-read the scripts folder to pick up fetchers added outside OpenBoard.',
  clear: 'Forget the address and App Password. Revoke it in your Google account to cut access off.',
  back: 'Return to Integrations.',
};

/** Guidance for the input steps, which have no highlighted row to describe. */
const STEP_DETAIL: Record<string, string> = {
  'scripts-dir': "Keep them in OpenBoard's folder (pre-filled) so invoices live alongside. Quotes are fine.",
  email: 'The Gmail account the fetchers sign in as.',
  'app-password': 'Create one at myaccount.google.com/apppasswords — 16 characters, not your Gmail password.',
  interval: 'Whole minutes. Runs are scheduled from the last fetch.',
};

export function GmailIntegrationScreen({ onNavigate, onBillersConfigured }: Props) {
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
  const [showHelp, setShowHelp] = useState(false);

  // Bound to the shared activity log, not local state: scheduled fetches run
  // with no screen mounted, so their output has to survive until someone opens
  // this screen. "Fetch now" writes to the same log.
  // `status` stays for short inline form validation next to the input.
  const log = useProgressLog({ store: billerActivityLog });

  useInput((input, key) => {
    if (key.escape && !busy) {
      if (step === 'menu') onNavigate(parentOf('integrations-gmail'));
      else setStep('menu');
    }

    // '?' expands the guidance the detail line shows one row at a time.
    if (input === '?' && step === 'menu' && !busy) {
      setShowHelp((on) => !on);
      return;
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
    const run = beginBillerRun('manual');
    try {
      // No truncation: the pane wraps, so a long fetcher line stays readable
      // instead of being cut at 120 characters.
      const results = await new BillerFetcherService().syncEnabled({
        onProgress: log.append,
        signal: run.controller.signal,
        // A manual fetch is the same work a scheduled tick does, so it anchors
        // the schedule — and it anchors at the start, so stopping half way
        // still counts the billers that did run instead of replaying them all.
        onStart: () => recordBillerRun(),
      });
      if (results.skipped === 'locked') return;
      if (results.length === 0) {
        // Distinguish "none switched on" from "the folder went missing".
        log.append(billers.length === 0
          ? `No biller scripts found in ${settings.scriptsDir}. Check the folder still exists, then use "Rescan folder".`
          : 'No billers are enabled yet — switch one on in the list above.');
        return;
      }

      const failed = results.filter((r) => !r.ok);
      const updated = results.filter((r) => r.changed);
      log.append(run.controller.signal.aborted
        ? `Stopped after ${results.length} of ${billers.length} fetcher(s).`
        : failed.length > 0
          ? `Failed: ${summariseFailures(failed.map((r) => `${r.displayName} (${r.error})`))}`
          : updated.length > 0
            ? `Fetched new invoices for ${updated.map((r) => r.displayName).join(', ')}; dashboards refreshed.`
            : `Ran ${results.length} fetcher(s) — no new invoices found.`);
    } catch (error: any) {
      log.append(error?.name === 'AbortError' ? 'Fetch stopped.' : `Sync failed: ${error.message}`);
    } finally {
      endBillerRun(run);
      setBusy(false);
      // Refresh the screen and restart the scheduler either way.
      changed();
    }
  };

  /** Stop whatever fetch is running — this screen's, or the schedule's. */
  const stopFetch = () => {
    const stopped = stopBillerRun();
    // Saying "stopped" when nothing was running taught users to distrust it.
    setStatus(stopped
      ? `Stopping the ${stopped.origin} fetch — the current biller is being terminated.`
      : 'No fetch is running.');
    log.append(stopped ? `Stop requested for the ${stopped.origin} fetch.` : 'Stop requested, but no fetch was running.');
    refresh();
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

  // Labels carry their current value inline rather than "(current: …)" — the
  // parenthetical repeated on every configurable row and doubled its length.
  // Includes a scheduled run this screen did not start, so the row can offer to
  // stop it. Read at render time; the log pane re-renders as a run streams lines.
  const running = activeBillerRun();

  const menuItems = [
    // Offered first on a fresh setup: one keypress from nothing to a working
    // folder, instead of hunting for scripts the user may not have yet.
    ...(hasDir ? [] : [{ label: 'Install bundled fetchers', value: 'install' }]),
    { label: hasDir ? `Scripts folder — ${settings.scriptsDir}` : 'Scripts folder — not set', value: 'dir' },
    ...(hasDir ? [{ label: hasEmail ? `Gmail address — ${settings.email}` : 'Gmail address — not set', value: 'email' }] : []),
    ...(hasDir && hasEmail
      ? [{ label: hasPassword ? 'App Password — set' : 'App Password — not set', value: 'password' }]
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
          { label: '✚ Add a biller', value: 'add-biller' },
          { label: `Fetch interval — ${settings.syncIntervalMinutes} min`, value: 'interval' },
          // The row reflects what is actually happening, including a scheduled
          // run this screen did not start — otherwise a wedged fetcher could
          // only be ended by killing the terminal.
          running
            ? { label: `■ Stop fetch (${running.origin})`, value: 'stop' }
            : { label: 'Fetch now', value: 'sync' },
          { label: 'Rescan folder', value: 'rescan' },
          { label: 'Clear credentials', value: 'clear' },
        ]
      : []),
    { label: '← Back', value: 'back' },
  ];

  const handleMenuSelect = (item: { value: string }) => {
    // Stop is the one action that must work while a fetch is in flight — that
    // is the only time it exists, and a blanket busy-guard would swallow it.
    if (item.value === 'stop') { stopFetch(); return; }
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
    else onNavigate(parentOf('integrations-gmail'));
  };

  // Five stacked status lines became one row of facts. Each is short enough to
  // scan and only appears once it is true, so the line grows with setup instead
  // of announcing what has not happened yet.
  const meta = [
    !hasDir ? 'no scripts folder' : !hasEmail ? 'address needed' : !hasPassword ? 'password needed' : 'ready',
    hasDir && hasEmail && hasPassword && `${settings.enabledKeys.length}/${billers.length} billers on`,
    settings.lastRunAt && `last ${new Date(settings.lastRunAt).toLocaleTimeString()}`,
    // Derived from the same lastRunAt anchor the scheduler uses. The loop only
    // runs while OpenBoard is open, which the wording has to stay honest about.
    // While a fetch is in flight, say so instead of showing a countdown. The
    // schedule anchors at the start of a run, so the two together previously
    // read as "due now" for the whole run and looked like nothing was happening.
    running
      ? `fetching now (${running.origin})`
      : isBillerSyncConfigured(settings) && `next ${describeNextRun(msUntilDue(settings))} while open`,
  ];

  // Data with no fetcher behind it renders a dashboard that quietly stops
  // updating, which looks identical to one that is simply up to date. This is a
  // real problem rather than guidance, so it stays visible.
  const stale = hasDir ? stalePronedDataKeys(settings.scriptsDir) : [];

  const detail = step === 'menu' ? ROW_DETAIL[highlighted] : STEP_DETAIL[step];

  return (
    <ScreenFrame
      title={['Integrations', 'Gmail']}
      meta={meta}
      detail={detail}
      status={status}
      statusTone={busy ? 'busy' : undefined}
      hints={step === 'menu' ? ['move', 'toggle', 'select', 'scroll', 'help', 'back'] : ['save', 'back']}
    >
      {stale.length > 0 && (
        <Text color="yellow">No fetcher for {stale.join(', ')} — those dashboards will not refresh.</Text>
      )}

      {showHelp && step === 'menu' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={UI_COLORS.subtitle}>
            Fetchers read Gmail over IMAP. Your App Password is encrypted and handed to each
            fetcher through its environment at run time — never written to disk. It grants full
            mailbox read access, so revoke it in your Google account to cut access off.
          </Text>
          <Text color={UI_COLORS.subtitle}>
            Fetchers need Python 3 with beautifulsoup4. Fetching runs only while OpenBoard is open.
          </Text>
        </Box>
      )}

      {step === 'scripts-dir' && (
        <Box>
          <Text color={UI_COLORS.logo}>Folder › </Text>
          <TextInput
            value={dirInput}
            onChange={setDirInput}
            onSubmit={saveScriptsDir}
            placeholder="C:\path\to\invoice_fetchers"
          />
        </Box>
      )}
      {step === 'email' && (
        <Box>
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
      )}
      {step === 'interval' && (
        <Box>
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
        <SelectInput
          items={menuItems}
          onSelect={handleMenuSelect}
          onHighlight={(item) => setHighlighted(item.value)}
        />
      )}

      {/* Progress belongs below every option, never above them. */}
      <LogPane view={log.view} title="Fetch log" />
    </ScreenFrame>
  );
}
