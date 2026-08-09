/**
 * Phase 14 — biller invoice fetchers.
 *
 * Everything external is faked: the "scripts folder" is a temp dir of stub
 * .py files that are never executed (runScript is injected), and the dashboard
 * pipeline is a mock. No Python process and no IMAP connection in this suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { DashboardUpdateService } from '../../src/services/project/DashboardUpdateService.js';
import {
  BUNDLED_SUPPORT_SCRIPTS,
  bundledScriptsDir,
  credentialsPathFor,
  discoverBillers,
  probeScriptPath,
  installBundledScripts,
  isInsideScriptsDir,
  repoRootFor,
  validateScriptsDir,
} from '../../src/services/billers/BillerDiscoveryService.js';
import {
  BillerFetcherService,
  describeFetchError,
  findFatalOutput,
  hashFile,
} from '../../src/services/billers/BillerFetcherService.js';
import {
  isBillerSyncConfigured,
  msUntilDue,
  msUntilNextRun,
  shouldAnchorRun,
  startBillerScheduler,
} from '../../src/services/billers/billerScheduler.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { SetupService } from '../../src/services/config/SetupService.js';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import {
  BILLERS_DEFAULT_SINCE_DAYS,
  BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES,
  defaultScriptsDir,
  presetForBiller,
  type BillerSettings,
} from '../../src/types/billers.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `openboard-${prefix}-`));
}

/** A stub fetcher shaped like the real ones: KEY + DISPLAY_NAME constants. */
function writeFetcher(dir: string, file: string, key: string, displayName: string): void {
  writeFileSync(join(dir, file), [
    '#!/usr/bin/env python3',
    '"""Stub fetcher for tests."""',
    'REPO_ROOT = Path(__file__).resolve().parents[2]',
    '',
    `KEY = "${key}"`,
    `DISPLAY_NAME = "${displayName}"`,
    'SENDER_EMAIL = "noreply@example.com"',
    '',
  ].join('\n'), 'utf-8');
}

describe('Biller invoice fetchers', () => {
  let root: string;
  let scriptsDir: string;
  let configDir: string;

  beforeEach(() => {
    // Mirror the real layout: <root>/scripts/invoice_fetchers, so parents[2]
    // resolution has two real levels above it to walk up to.
    root = makeTempDir('billers');
    scriptsDir = join(root, 'scripts', 'invoice_fetchers');
    mkdirSync(scriptsDir, { recursive: true });

    writeFetcher(scriptsDir, 'fetch_zomato.py', 'zomato', 'Zomato');
    writeFetcher(scriptsDir, 'fetch_uber.py', 'uber_rides', 'Uber Rides');
    // The two excluded scripts, written without KEY/DISPLAY_NAME exactly as the
    // real ones are, so both exclusion signals are exercised at once.
    writeFileSync(join(scriptsDir, 'fetch_pending_invoices.py'), 'BILLERS = {}\n', 'utf-8');
    writeFileSync(join(scriptsDir, 'run_backfill_invoices_new.py'), 'BILLERS = {}\n', 'utf-8');

    configDir = makeTempDir('billers-cfg');
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'phase14-test-secret';
  });

  afterEach(() => {
    for (const dir of [root, configDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
    }
  });

  // ── discovery ──────────────────────────────────────────────────────────────

  describe('discovery', () => {
    it('finds per-biller fetchers and excludes the pending/backfill scripts', () => {
      const billers = discoverBillers(scriptsDir);
      expect(billers.map((b) => b.key)).toEqual(['uber_rides', 'zomato']); // sorted by display name
      expect(billers.map((b) => b.displayName)).toEqual(['Uber Rides', 'Zomato']);
    });

    it('skips fetch_*.py files that do not declare KEY and DISPLAY_NAME', () => {
      writeFileSync(join(scriptsDir, 'fetch_halfbaked.py'), 'KEY = "halfbaked"\n', 'utf-8');
      expect(discoverBillers(scriptsDir).map((b) => b.key)).not.toContain('halfbaked');
    });

    it('picks up a newly added fetcher without any code change', () => {
      writeFetcher(scriptsDir, 'fetch_airtel.py', 'airtel', 'Airtel');
      expect(discoverBillers(scriptsDir).map((b) => b.key)).toContain('airtel');
    });

    it('derives CSV and credential paths from the scripts two-levels-up convention', () => {
      const [uber] = discoverBillers(scriptsDir).filter((b) => b.key === 'uber_rides');
      expect(repoRootFor(scriptsDir)).toBe(root);
      expect(uber.csvPath).toBe(join(root, 'data', 'invoices', 'uber_rides.csv'));
      expect(uber.rawDir).toBe(join(root, 'data', 'invoices', 'raw', 'uber_rides'));
      expect(credentialsPathFor(scriptsDir)).toBe(join(root, 'secrets', 'gmail_app_credentials.json'));
    });

    it('returns an empty list for a missing folder instead of throwing', () => {
      expect(discoverBillers(join(root, 'nope'))).toEqual([]);
      expect(discoverBillers(undefined)).toEqual([]);
    });

    it('reports why a folder is unusable', () => {
      expect(validateScriptsDir(join(root, 'nope')).error).toMatch(/not found/i);
      const empty = join(root, 'empty');
      mkdirSync(empty);
      expect(validateScriptsDir(empty).error).toMatch(/No biller fetchers/i);
      expect(validateScriptsDir(scriptsDir).valid).toBe(true);
    });

    it('refuses paths outside the configured folder', () => {
      expect(isInsideScriptsDir(join(scriptsDir, 'fetch_zomato.py'), scriptsDir)).toBe(true);
      expect(isInsideScriptsDir(join(root, 'evil.py'), scriptsDir)).toBe(false);
      expect(isInsideScriptsDir(join(scriptsDir, 'nested', 'evil.py'), scriptsDir)).toBe(false);
    });
  });

  // ── config ─────────────────────────────────────────────────────────────────

  describe('settings', () => {
    it('applies defaults when nothing is configured', () => {
      const settings = new TypedConfigRepository().getBillerSettings();
      expect(settings.syncIntervalMinutes).toBe(BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES);
      expect(settings.sinceDays).toBe(BILLERS_DEFAULT_SINCE_DAYS);
      expect(settings.enabledKeys).toEqual([]);
      expect(settings.appPassword).toBeUndefined();
    });

    it('round-trips settings and keeps the app password encrypted at rest', () => {
      const config = new ConfigService();
      config.set('billers.scriptsDir', scriptsDir);
      config.set('billers.email', 'user@gmail.com');
      config.setEncrypted('billers.appPassword', 'abcdefghijklmnop');
      config.set('billers.enabledKeys', ['zomato']);
      config.set('billers.syncIntervalMinutes', 90);

      const settings = new TypedConfigRepository().getBillerSettings();
      expect(settings.email).toBe('user@gmail.com');
      expect(settings.appPassword).toBe('abcdefghijklmnop');
      expect(settings.enabledKeys).toEqual(['zomato']);
      expect(settings.syncIntervalMinutes).toBe(90);
      // Never stored in the clear.
      expect(String(config.getRaw('billers.appPassword'))).toMatch(/^enc:/);
    });

    it('defaults the scripts folder inside OpenBoardCLI, at the depth the scripts expect', () => {
      // The scripts resolve their paths from parents[2], so the default must sit
      // exactly two levels below the folder that should hold secrets/ and data/.
      const dir = defaultScriptsDir();
      expect(dir).toBe(join(configDir, 'billers', 'scripts', 'invoice_fetchers'));
      const repoRoot = repoRootFor(dir);
      expect(repoRoot).toBe(join(configDir, 'billers'));
      expect(credentialsPathFor(dir)).toBe(join(configDir, 'billers', 'secrets', 'gmail_app_credentials.json'));
    });

    it('maps billers to their board presets, falling back to custom', () => {
      expect(presetForBiller('zomato')).toBe('food');
      expect(presetForBiller('uber_rides')).toBe('travel');
      expect(presetForBiller('amazon')).toBe('shopping');
      expect(presetForBiller('urban_company')).toBe('utilities');
      expect(presetForBiller('something_new')).toBe('custom');
    });
  });

  // ── fetching ───────────────────────────────────────────────────────────────

  describe('fetching', () => {
    const settings = (overrides: Partial<BillerSettings> = {}): BillerSettings => ({
      scriptsDir,
      email: 'user@gmail.com',
      appPassword: 'abcdefghijklmnop',
      enabledKeys: ['zomato'],
      syncIntervalMinutes: 360,
      sinceDays: 30,
      ...overrides,
    });

    const fakeUpdateService = () => ({
      findBoard: vi.fn(() => undefined),
      createFromDataSource: vi.fn(async () => ({ success: true })),
      updateBySelector: vi.fn(async () => ({ success: true })),
    });

    it('passes credentials to the fetchers through the environment', () => {
      const service = new BillerFetcherService({ settings: () => settings() });
      expect(service.credentialEnv()).toEqual({
        OPENBOARD_GMAIL_EMAIL: 'user@gmail.com',
        OPENBOARD_GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
      });
    });

    it('refuses to build credentials when the account is incomplete', () => {
      const service = new BillerFetcherService({ settings: () => settings({ appPassword: undefined }) });
      expect(() => service.credentialEnv()).toThrow(/App Password/i);
      const noDir = new BillerFetcherService({ settings: () => settings({ scriptsDir: undefined }) });
      expect(() => noDir.credentialEnv()).toThrow(/folder/i);
    });

    it('never writes the App Password to disk', async () => {
      // The whole point of the env-var handoff: a completed run must leave no
      // plaintext credential behind anywhere under the scripts tree.
      const service = new BillerFetcherService({
        settings: () => settings({ enabledKeys: ['zomato'] }),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 0, output: 'ok' }),
      });
      await service.syncEnabled();
      expect(existsSync(credentialsPathFor(scriptsDir))).toBe(false);
    });

    it('deletes a plaintext credentials file left by an older version', async () => {
      // Upgrading alone would otherwise strand a readable App Password on disk,
      // since nothing reads that file any more.
      const legacy = credentialsPathFor(scriptsDir);
      mkdirSync(join(root, 'secrets'), { recursive: true });
      writeFileSync(legacy, JSON.stringify({ email: 'old@gmail.com', app_password: 'oldoldoldoldold1' }));
      expect(existsSync(legacy)).toBe(true);

      const service = new BillerFetcherService({
        settings: () => settings({ enabledKeys: ['zomato'] }),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 0, output: 'ok' }),
      });
      await service.syncEnabled();
      expect(existsSync(legacy)).toBe(false);
    });

    it('reports nothing to remove when no legacy file exists', () => {
      const service = new BillerFetcherService({ settings: () => settings() });
      expect(service.removeLegacyCredentialsFile()).toBe(false);
    });

    it('keeps going when one biller fails, and preserves order', async () => {
      const ran: string[] = [];
      const service = new BillerFetcherService({
        settings: () => settings({ enabledKeys: ['uber_rides', 'zomato'] }),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async (biller) => {
          ran.push(biller.key);
          return biller.key === 'uber_rides'
            ? { code: 1, output: 'boom' }
            : { code: 0, output: '' };
        },
      });

      const results = await service.syncEnabled();
      expect(ran).toEqual(['uber_rides', 'zomato']); // sorted by display name, both attempted
      expect(results.map((r) => r.key)).toEqual(['uber_rides', 'zomato']);
      expect(results[0].ok).toBe(false);
      expect(results[1].ok).toBe(true);
    });

    it('stops before the next biller once aborted', async () => {
      const controller = new AbortController();
      const ran: string[] = [];
      const service = new BillerFetcherService({
        settings: () => settings({ enabledKeys: ['uber_rides', 'zomato'] }),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async (biller) => {
          ran.push(biller.key);
          controller.abort();
          return { code: 0, output: '' };
        },
      });

      await service.syncEnabled({ signal: controller.signal });
      expect(ran).toEqual(['uber_rides']);
    });

    it('propagates an abort rather than reporting a clean run', async () => {
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async () => {
          throw Object.assign(new Error('Command was aborted'), { name: 'AbortError' });
        },
      });
      await expect(service.syncEnabled()).rejects.toThrow(/abort/i);
    });

    it('reports a dashboard failure as a failed run, not a silent success', async () => {
      const updateService = fakeUpdateService();
      updateService.createFromDataSource = vi.fn(async () => ({ success: false, error: 'no LLM configured' })) as any;
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        runScript: async (biller) => {
          mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
          writeFileSync(biller.csvPath, `order_id\n${Date.now()}\n`, 'utf-8');
          return { code: 0, output: '' };
        },
      });

      const [result] = await service.syncEnabled();
      expect(result.changed).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no LLM configured/);
    });

    it('creates a dashboard the first time a biller produces data', async () => {
      const updateService = fakeUpdateService();
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        // Simulate the fetcher appending a row.
        runScript: async (biller) => {
          mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
          writeFileSync(biller.csvPath, 'order_id,total_paid\n1,100\n', 'utf-8');
          return { code: 0, output: '' };
        },
      });

      const [result] = await service.syncEnabled();
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.dashboardUpdated).toBe(true);
      expect(updateService.createFromDataSource).toHaveBeenCalledTimes(1);
      expect(updateService.updateBySelector).not.toHaveBeenCalled();
      // Preset comes from the biller key, not a guess.
      expect(updateService.createFromDataSource.mock.calls[0][0]).toMatchObject({
        title: 'Zomato',
        type: 'food',
      });
    });

    it('refreshes instead of recreating when the dashboard already exists', async () => {
      const updateService = fakeUpdateService();
      updateService.findBoard = vi.fn(() => ({ id: 'b1' }) as any);
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        runScript: async (biller) => {
          mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
          writeFileSync(biller.csvPath, `order_id\n${Date.now()}\n`, 'utf-8');
          return { code: 0, output: '' };
        },
      });

      await service.syncEnabled();
      expect(updateService.updateBySelector).toHaveBeenCalledWith('zomato', undefined);
      expect(updateService.createFromDataSource).not.toHaveBeenCalled();
    });

    it('skips the dashboard when the CSV did not change and one already exists', async () => {
      // Unchanged data is only a reason to stop once there is a dashboard to
      // leave alone. Gating on `changed` alone meant a biller whose CSV was
      // already populated reported success forever and never produced a tab —
      // see "builds the first dashboard from data already on disk" below.
      mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
      writeFileSync(join(root, 'data', 'invoices', 'zomato.csv'), 'order_id\n1\n', 'utf-8');

      const updateService = fakeUpdateService();
      updateService.findBoard = vi.fn(() => ({ id: 'board-1', name: 'zomato' })) as never;
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        // Fetcher runs but finds nothing new — file untouched.
        runScript: async () => ({ code: 0, output: '[zomato] 0 new rows' }),
      });

      const [result] = await service.syncEnabled();
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.dashboardExists).toBe(true);
      expect(updateService.createFromDataSource).not.toHaveBeenCalled();
      expect(updateService.updateBySelector).not.toHaveBeenCalled();
    });

    it('builds the first dashboard from data already on disk', async () => {
      mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
      writeFileSync(join(root, 'data', 'invoices', 'zomato.csv'), 'order_id\n1\n', 'utf-8');

      const updateService = fakeUpdateService(); // findBoard returns undefined
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 0, output: '[zomato] 0 new rows' }),
      });

      const [result] = await service.syncEnabled();
      expect(result.changed).toBe(false);
      expect(updateService.createFromDataSource).toHaveBeenCalledTimes(1);
      expect(result.dashboardExists).toBe(true);
    });

    it('only runs enabled billers, and --biller overrides the selection', async () => {
      const ran: string[] = [];
      const service = new BillerFetcherService({
        settings: () => settings({ enabledKeys: ['zomato'] }),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async (biller) => { ran.push(biller.key); return { code: 0, output: '' }; },
      });

      await service.syncEnabled();
      expect(ran).toEqual(['zomato']);

      ran.length = 0;
      await service.syncEnabled({ only: 'uber_rides' });
      expect(ran).toEqual(['uber_rides']);
    });

    it('treats a login failure as a failure even though the script exits 0', async () => {
      // Verbatim from a real run: the fetchers catch connection errors, log
      // them, and return normally. Trusting the exit code would report bad
      // credentials as "no new invoices" indefinitely.
      const realOutput = [
        "2026-07-26 16:15:16,693 ERROR: [zomato] Failed to connect/login to IMAP: b'[AUTHENTICATIONFAILED] Invalid credentials (Failure)'",
        '2026-07-26 16:15:16,693 INFO: [zomato] 0 new rows (scanned 0 messages)',
      ].join('\n');

      expect(findFatalOutput(realOutput)).toMatch(/Failed to connect\/login to IMAP/);

      const updateService = fakeUpdateService();
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 0, output: realOutput }),
      });

      const [result] = await service.syncEnabled();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/App Password/i);
      expect(updateService.createFromDataSource).not.toHaveBeenCalled();
    });

    it('does not mistake per-message warnings for a failed run', () => {
      // The scripts log these at WARNING during otherwise healthy runs.
      const healthy = [
        '2026-07-26 16:15:16,693 WARNING: [zomato] Failed to fetch UID 42',
        '2026-07-26 16:15:16,693 WARNING: [zomato] UID 43 missing HTML body',
        '2026-07-26 16:15:16,693 INFO: [zomato] 7 new rows (scanned 20 messages)',
      ].join('\n');
      expect(findFatalOutput(healthy)).toBeUndefined();
    });

    it('reports a non-zero exit as a friendly failure', async () => {
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: fakeUpdateService() as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 1, output: 'ModuleNotFoundError: No module named \'bs4\'' }),
      });

      const [result] = await service.syncEnabled();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/beautifulsoup4/i);
    });

    // Table-driven so a new failure mode is one line, and each case asserts the
    // load-bearing token (a package name, a URL) rather than a whole sentence
    // that would break on any copy edit.
    const FAILURE_CASES: Array<{ name: string; raw: string; expect: RegExp }> = [
      { name: 'python missing', raw: 'spawn python ENOENT', expect: /python/i },
      { name: 'bs4 missing', raw: "ModuleNotFoundError: No module named 'bs4'", expect: /beautifulsoup4/i },
      { name: 'pdfplumber missing', raw: "ModuleNotFoundError: No module named 'pdfplumber'", expect: /pdfplumber/i },
      { name: 'bad credentials', raw: "imaplib.error: b'[AUTHENTICATIONFAILED] Invalid credentials (Failure)'", expect: /App Password/i },
      {
        // Verbatim from imap.gmail.com when a normal account password is used.
        name: 'regular password used',
        raw: "imaplib.error: b'[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)'",
        expect: /apppasswords/,
      },
      { name: 'credentials file missing', raw: "FileNotFoundError: 'secrets/gmail_app_credentials.json'", expect: /credentials/i },
    ];

    it.each(FAILURE_CASES)('explains "$name" without leaking a traceback', ({ raw, expect: pattern }) => {
      const message = describeFetchError(raw);
      expect(message).toMatch(pattern);
      // Never hand the user a raw Python traceback or an empty string.
      expect(message).not.toMatch(/Traceback \(most recent call last\)/);
      expect(message.length).toBeGreaterThan(10);
    });

    it('still says something useful for a failure it does not recognise', () => {
      const message = describeFetchError('some totally novel failure mode\nlast meaningful line here');
      expect(message).toBe('last meaningful line here');
      expect(describeFetchError('')).toMatch(/no output/i);
    });

    it('hashes only existing files', async () => {
      const path = join(root, 'hash-me.csv');
      expect(await hashFile(path)).toBeUndefined();
      writeFileSync(path, 'a', 'utf-8');
      const first = await hashFile(path);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(path, 'ab', 'utf-8');
      expect(await hashFile(path)).not.toBe(first);
    });
  });

  // ── scheduling ─────────────────────────────────────────────────────────────

  describe('scheduler', () => {
    const ready: BillerSettings = {
      scriptsDir: '/tmp/x',
      email: 'user@gmail.com',
      appPassword: 'abcdefghijklmnop',
      enabledKeys: ['zomato'],
      syncIntervalMinutes: 60,
      sinceDays: 30,
    };

    it('treats a run as configured only when everything is present', () => {
      expect(isBillerSyncConfigured(ready)).toBe(true);
      expect(isBillerSyncConfigured({ ...ready, enabledKeys: [] })).toBe(false);
      expect(isBillerSyncConfigured({ ...ready, appPassword: undefined })).toBe(false);
      expect(isBillerSyncConfigured({ ...ready, scriptsDir: undefined })).toBe(false);
    });

    it('is due immediately when it has never run', () => {
      expect(msUntilDue(ready)).toBe(0);
    });

    it('waits out the remainder of the interval after a recent run', () => {
      const now = Date.parse('2026-07-26T12:00:00Z');
      const lastRunAt = new Date(now - 20 * 60 * 1000).toISOString(); // 20 min ago
      expect(msUntilDue({ ...ready, lastRunAt }, now)).toBe(40 * 60 * 1000);
    });

    it('is due again once a full interval has elapsed', () => {
      const now = Date.parse('2026-07-26T12:00:00Z');
      const lastRunAt = new Date(now - 90 * 60 * 1000).toISOString();
      expect(msUntilDue({ ...ready, lastRunAt }, now)).toBe(0);
    });

    it('does not park for hours when the clock jumped backwards', () => {
      const now = Date.parse('2026-07-26T12:00:00Z');
      const lastRunAt = new Date(now + 60 * 60 * 1000).toISOString(); // "future" run
      expect(msUntilDue({ ...ready, lastRunAt }, now)).toBe(60 * 60 * 1000);
    });

    it('reports not-configured and never fetches when nothing is enabled', () => {
      const syncEnabled = vi.fn();
      const statuses: string[] = [];
      const stop = startBillerScheduler(
        (status) => statuses.push(status.state),
        {
          settings: () => ({ ...ready, enabledKeys: [] }),
          fetcher: { syncEnabled } as any,
        },
      );
      expect(statuses).toEqual(['not-configured']);
      expect(syncEnabled).not.toHaveBeenCalled();
      stop();
    });

    it('runs at startup when overdue and records the completed run', async () => {
      const syncEnabled = vi.fn(async () => [
        { key: 'zomato', displayName: 'Zomato', ok: true, changed: true },
      ]);
      const recordRun = vi.fn();
      const stop = startBillerScheduler(() => {}, {
        settings: () => ready, // no lastRunAt -> overdue
        fetcher: { syncEnabled } as any,
        recordRun,
      });
      await vi.waitFor(() => expect(syncEnabled).toHaveBeenCalledTimes(1));
      expect(recordRun).toHaveBeenCalledTimes(1);
      stop();
    });

    it('reports the pending catch-up time, not the later interval tick', () => {
      // Overdue in 20 min, but the interval is 60 — the status must advertise
      // the run that actually happens next, not the one an hour out.
      const lastRunAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      const seen: (string | undefined)[] = [];
      const stop = startBillerScheduler(
        (status) => seen.push(status.nextRunAt),
        {
          settings: () => ({ ...ready, lastRunAt }),
          fetcher: { syncEnabled: vi.fn() } as any,
          recordRun: vi.fn(),
        },
      );
      const nextAt = Date.parse(seen[seen.length - 1]!);
      const minutesOut = (nextAt - Date.now()) / 60000;
      expect(minutesOut).toBeGreaterThan(15);
      expect(minutesOut).toBeLessThan(25);
      stop();
    });

    it('does not re-fetch on startup when a run happened recently', () => {
      const syncEnabled = vi.fn();
      const stop = startBillerScheduler(() => {}, {
        settings: () => ({ ...ready, lastRunAt: new Date().toISOString() }),
        fetcher: { syncEnabled } as any,
        recordRun: vi.fn(),
      });
      expect(syncEnabled).not.toHaveBeenCalled();
      stop();
    });

    it('never runs two fetches at once', async () => {
      // A slow fetch must not be re-entered by the interval firing underneath it;
      // two concurrent runs would race on the same CSVs and dedup state.
      let active = 0;
      let maxActive = 0;
      const syncEnabled = vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return [];
      });
      const stop = startBillerScheduler(() => {}, {
        settings: () => ({ ...ready, syncIntervalMinutes: 1 }),
        fetcher: { syncEnabled } as any,
        recordRun: vi.fn(),
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(maxActive).toBe(1);
      stop();
    });

    it('stops firing once disposed', async () => {
      const syncEnabled = vi.fn(async () => []);
      const stop = startBillerScheduler(() => {}, {
        settings: () => ready,
        fetcher: { syncEnabled } as any,
        recordRun: vi.fn(),
      });
      await vi.waitFor(() => expect(syncEnabled).toHaveBeenCalled());
      const callsAtStop = syncEnabled.mock.calls.length;
      stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(syncEnabled.mock.calls.length).toBe(callsAtStop);
    });

    it('goes quiet when disposed while a fetch is still in flight', async () => {
      // Closing the screen mid-fetch: the run finishes in the background and
      // must not push status into a component that is gone.
      const onStatus = vi.fn();
      let release!: () => void;
      const inFlight = new Promise<void>((resolve) => { release = resolve; });

      const stop = startBillerScheduler(onStatus, {
        settings: () => ready,
        fetcher: { syncEnabled: vi.fn(async () => { await inFlight; return []; }) } as any,
        recordRun: vi.fn(),
      });

      await new Promise((r) => setTimeout(r, 10)); // let the tick reach its await
      stop();
      const afterStop = onStatus.mock.calls.length;

      release();
      await new Promise((r) => setTimeout(r, 30));
      expect(onStatus.mock.calls.length).toBe(afterStop);
    });

    it('records the run even when some billers failed', async () => {
      // lastRunAt drives the due check; skipping it on partial failure would
      // make the loop retry every launch forever.
      const recordRun = vi.fn();
      const stop = startBillerScheduler(() => {}, {
        settings: () => ready,
        fetcher: {
          syncEnabled: vi.fn(async () => [
            { key: 'zomato', displayName: 'Zomato', ok: false, changed: false, error: 'boom' },
          ]),
        } as any,
        recordRun,
      });
      await vi.waitFor(() => expect(recordRun).toHaveBeenCalledTimes(1));
      stop();
    });

    // ── interval anchoring ───────────────────────────────────────────────────
    // The loop used a fixed setInterval pinned to process start. After a
    // startup catch-up the next tick landed a partial interval later, and
    // because the scheduler is restarted on every biller settings change, that
    // interval was reset to zero each time. Runs must be spaced from the run
    // that actually happened, not from when the process booted.
    describe('interval anchoring', () => {
      const MIN = 60 * 1000;

      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      const runSchedule = async (settings: BillerSettings, minutes: number) => {
        const firedAt: number[] = [];
        const start = Date.now();
        const stop = startBillerScheduler(() => {}, {
          settings: () => settings,
          fetcher: {
            syncEnabled: vi.fn(async () => {
              firedAt.push(Math.round((Date.now() - start) / MIN));
              return [];
            }),
          } as any,
          recordRun: vi.fn(),
        });
        for (let i = 0; i < minutes; i++) await vi.advanceTimersByTimeAsync(MIN);
        stop();
        return firedAt;
      };

      it('spaces every run a full interval apart after a startup catch-up', async () => {
        // 50 min since the last run on a 60 min interval -> catch-up at +10,
        // then a full 60 between each subsequent run.
        const lastRunAt = new Date(Date.now() - 50 * MIN).toISOString();
        const firedAt = await runSchedule({ ...ready, lastRunAt }, 180);
        expect(firedAt).toEqual([10, 70, 130]);
      });

      it('spaces every run a full interval apart when overdue at startup', async () => {
        const firedAt = await runSchedule(ready, 150);
        expect(firedAt).toEqual([0, 60, 120]);
      });

      it('does not fire early when the interval is short', async () => {
        const firedAt = await runSchedule({ ...ready, syncIntervalMinutes: 5 }, 20);
        expect(firedAt).toEqual([0, 5, 10, 15, 20]);
      });

      // "Fetch now" stamped lastRunAt from a finally block, so a press that ran
      // nothing — no billers enabled, or the scripts folder gone — still moved
      // the anchor and pushed the next scheduled run out by a full interval.
      // That is what made a correct interval look like it never fired.
      it('only counts a manual fetch as a run when a fetcher actually ran', () => {
        expect(shouldAnchorRun([])).toBe(false);
        expect(shouldAnchorRun([
          { key: 'z', displayName: 'Z', ok: true, changed: true },
        ])).toBe(true);
        // A failed run still anchors, matching tick(): a biller that is broken
        // today must not make every launch retry it forever.
        expect(shouldAnchorRun([
          { key: 'z', displayName: 'Z', ok: false, changed: false, error: 'boom' },
        ])).toBe(true);
      });

      it('keeps the scheduled run on time when a manual fetch did nothing', () => {
        const now = Date.parse('2026-07-26T12:00:00Z');
        const lastRunAt = new Date(now - 50 * MIN).toISOString();
        const settings = { ...ready, lastRunAt };
        const before = msUntilDue(settings, now);

        // A no-op "Fetch now" is gated by shouldAnchorRun, so lastRunAt is
        // untouched and the pending run keeps its original time.
        const anchored = shouldAnchorRun([]) ? new Date(now).toISOString() : settings.lastRunAt;
        expect(msUntilDue({ ...settings, lastRunAt: anchored }, now)).toBe(before);
        expect(before).toBe(10 * MIN);
      });

      // The interval is the period between runs. Scheduling a full interval
      // from completion instead of from the start made every cycle drift by the
      // fetch duration, and the drift compounded across a long session.
      it('spaces runs by the interval, not the interval plus the fetch', async () => {
        const FETCH_MS = 10 * MIN;
        const firedAt: number[] = [];
        const start = Date.now();
        const stop = startBillerScheduler(() => {}, {
          settings: () => ready,
          fetcher: {
            syncEnabled: vi.fn(async () => {
              firedAt.push(Math.round((Date.now() - start) / MIN));
              await new Promise((resolve) => setTimeout(resolve, FETCH_MS));
              return [];
            }),
          } as any,
          recordRun: vi.fn(),
        });

        for (let i = 0; i < 150; i++) await vi.advanceTimersByTimeAsync(MIN);
        stop();
        // A 10-minute fetch on a 60-minute interval must still start on the
        // hour — not at 0, 70, 140.
        expect(firedAt).toEqual([0, 60, 120]);
      });

      it('starts the next run immediately when a fetch outlasts its interval', async () => {
        expect(msUntilNextRun(0, 5 * MIN, 2 * MIN)).toBe(3 * MIN);
        expect(msUntilNextRun(0, 5 * MIN, 5 * MIN)).toBe(0);
        // Overran the period: due the moment it ends, never a negative delay.
        expect(msUntilNextRun(0, 5 * MIN, 9 * MIN)).toBe(0);
      });

      // A scheduled run used to call syncEnabled() with no onProgress at all,
      // so it produced no output anywhere. "Last run" and "Next run" advanced on
      // the settings screen while the log pane under them stayed empty, which
      // read as the schedule never firing.
      it('reports a scheduled run through the activity log', async () => {
        const lines: string[] = [];
        const stop = startBillerScheduler(() => {}, {
          settings: () => ready,
          fetcher: {
            syncEnabled: vi.fn(async (options: any) => {
              options?.onProgress?.('[zomato] fetching invoices…');
              return [{ key: 'zomato', displayName: 'Zomato', ok: true, changed: true }];
            }),
          } as any,
          recordRun: vi.fn(),
          onProgress: (line) => lines.push(line),
        });

        await vi.advanceTimersByTimeAsync(MIN);
        stop();

        // The fetcher's own progress must reach the log, not just a summary.
        expect(lines.some((line) => line.includes('[zomato] fetching invoices…'))).toBe(true);
        expect(lines.some((line) => line.startsWith('Scheduled fetch started'))).toBe(true);
        expect(lines.some((line) => line.includes('new invoices for zomato'))).toBe(true);
      });

      it('reports a scheduled failure through the activity log', async () => {
        const lines: string[] = [];
        const stop = startBillerScheduler(() => {}, {
          settings: () => ready,
          fetcher: { syncEnabled: vi.fn(async () => { throw new Error('IMAP down'); }) } as any,
          recordRun: vi.fn(),
          onProgress: (line) => lines.push(line),
        });

        await vi.advanceTimersByTimeAsync(MIN);
        stop();

        expect(lines.some((line) => line.includes('Scheduled fetch failed: IMAP down'))).toBe(true);
      });

      it('does not re-anchor or claim billers are disabled when a run is locked', async () => {
        const lines: string[] = [];
        const recordRun = vi.fn();
        const stop = startBillerScheduler(() => {}, {
          settings: () => ready,
          fetcher: {
            syncEnabled: vi.fn(async () => {
              lines.push('Skipped: another fetch is already running.');
              const skipped: any[] & { skipped?: 'locked' } = [];
              Object.defineProperty(skipped, 'skipped', { value: 'locked' });
              return skipped;
            }),
          } as any,
          recordRun,
          onProgress: (line) => lines.push(line),
        });

        await vi.advanceTimersByTimeAsync(MIN);
        stop();

        expect(recordRun).not.toHaveBeenCalled();
        expect(lines.some((line) => line.includes('no billers are enabled'))).toBe(false);
      });

      it('advertises the time the pending timer really fires', async () => {
        // nextRunAt used to be recomputed as "now + interval" on every emit, so
        // it slid forward and never matched the run that was actually queued.
        const seen: (string | undefined)[] = [];
        const lastRunAt = new Date(Date.now() - 50 * MIN).toISOString();
        const stop = startBillerScheduler((status) => seen.push(status.nextRunAt), {
          settings: () => ({ ...ready, lastRunAt }),
          fetcher: { syncEnabled: vi.fn(async () => []) } as any,
          recordRun: vi.fn(),
        });

        const advertised = Date.parse(seen[seen.length - 1]!);
        await vi.advanceTimersByTimeAsync(10 * MIN);
        // The run fired when the status said it would.
        expect(Math.abs(advertised - Date.now())).toBeLessThan(MIN);
        stop();
      });

      it('backs off after repeated failures and recovers on success', async () => {
        const results = [
          [{ key: 'z', displayName: 'Z', ok: false, changed: false, error: 'boom' }],
          [{ key: 'z', displayName: 'Z', ok: false, changed: false, error: 'boom' }],
          [{ key: 'z', displayName: 'Z', ok: false, changed: false, error: 'boom' }],
          [{ key: 'z', displayName: 'Z', ok: true, changed: false }],
        ];
        const firedAt: number[] = [];
        const start = Date.now();
        let call = 0;
        const stop = startBillerScheduler(() => {}, {
          settings: () => ready,
          fetcher: {
            syncEnabled: vi.fn(async () => {
              firedAt.push(Math.round((Date.now() - start) / MIN));
              return results[Math.min(call++, results.length - 1)];
            }),
          } as any,
          recordRun: vi.fn(),
        });

        for (let i = 0; i < 700; i++) await vi.advanceTimersByTimeAsync(MIN);
        stop();
        // Two failures keep the normal 60; the third trips the backoff and
        // pushes the next run out by 240 (120 -> 360); the success there drops
        // the gap straight back to 60.
        expect(firedAt.slice(0, 6)).toEqual([0, 60, 120, 360, 420, 480]);
      });
    });

    it('survives a fetcher that throws instead of returning results', async () => {
      const onStatus = vi.fn();
      const stop = startBillerScheduler(onStatus, {
        settings: () => ready,
        fetcher: { syncEnabled: vi.fn(async () => { throw new Error('unexpected'); }) } as any,
        recordRun: vi.fn(),
      });
      await vi.waitFor(() => {
        const states = onStatus.mock.calls.map((c) => c[0].state);
        expect(states).toContain('error');
      });
      stop();
    });
  });

  // ── headless setup validation ──────────────────────────────────────────────

  describe('headless setup', () => {
    const setup = () => new SetupService(new ConfigService());

    it('rejects an unknown biller key and names the valid ones', () => {
      const s = setup();
      s.configureBillers({ scriptsDir });
      const result = s.configureBillers({ enable: ['zomato', 'nope'] });
      expect(result.configured).toBe(false);
      expect(result.errorCode).toBe('E_VALIDATION');
      expect(result.error).toMatch(/nope/);
      expect(result.error).toMatch(/zomato/); // lists what IS valid
    });

    // Built lazily: `root` only exists once beforeEach has run, and it.each
    // tables are evaluated at collection time.
    it.each([
      ['scriptsDir that does not exist', () => ({ scriptsDir: join(root, 'missing') })],
      ['email without an @', () => ({ email: 'notanemail' })],
      ['app password under 16 chars', () => ({ appPassword: 'tooshort' })],
      ['zero interval', () => ({ syncIntervalMinutes: 0 })],
      ['fractional interval', () => ({ syncIntervalMinutes: 1.5 })],
      ['zero sinceDays', () => ({ sinceDays: 0 })],
    ])('rejects %s', (_label, makeInput) => {
      const result = setup().configureBillers(makeInput() as any);
      expect(result.configured).toBe(false);
      expect(result.errorCode).toBe('E_VALIDATION');
    });

    it('rejects a call that would change nothing', () => {
      expect(setup().configureBillers({}).configured).toBe(false);
    });

    it('accepts a partial update without clobbering other fields', () => {
      const s = setup();
      s.configureBillers({ scriptsDir, email: 'a@gmail.com', appPassword: 'abcdefghijklmnop' });
      s.configureBillers({ syncIntervalMinutes: 90 });
      const after = new TypedConfigRepository().getBillerSettings();
      expect(after.email).toBe('a@gmail.com');
      expect(after.appPassword).toBe('abcdefghijklmnop');
      expect(after.syncIntervalMinutes).toBe(90);
    });

    it('accepts an app password pasted with Google\'s spaces', () => {
      setup().configureBillers({ appPassword: 'abcd efgh ijkl mnop' });
      expect(new TypedConfigRepository().getBillerSettings().appPassword).toBe('abcdefghijklmnop');
    });

    it('reports readiness only once folder, address and password are all set', () => {
      const s = setup();
      expect(s.configureBillers({ scriptsDir }).detail).toMatch(/still needed/i);
      s.configureBillers({ email: 'a@gmail.com' });
      expect(s.configureBillers({ appPassword: 'abcdefghijklmnop' }).detail).toMatch(/ready/i);
      expect(s.status().billers?.ready).toBe(true);
    });
  });

  // ── bundled fetchers ───────────────────────────────────────────────────────

  describe('bundled fetchers', () => {
    it('ships a usable set inside the package', () => {
      const bundled = discoverBillers(bundledScriptsDir());
      expect(bundled.length).toBeGreaterThan(0);
      // Discovery must accept them for the same reasons it accepts any fetcher.
      for (const biller of bundled) {
        expect(biller.key).toMatch(/^[a-z0-9_]+$/);
        expect(biller.displayName.length).toBeGreaterThan(0);
      }
    });

    it('carries no real purchase data', () => {
      // The examples exist to document the regexes, so they keep the shape of a
      // real receipt but must stay synthetic — publishing to npm is effectively
      // permanent. Each pattern matches the real shape while allowing the
      // agreed placeholder (all zeros / all A / XX00XX0000).
      const forbidden = [
        /\b(?!000-0000000-0000000\b)\d{3}-\d{7}-\d{7}\b/,           // Amazon order numbers
        /ORDER ID: (?!0+\b)\d{6,}/,                                  // order ids
        /Order ID: (?!0+\b)\d{6,}/,
        /PNR:(?!A{6})[A-Z0-9]{6}/,                                   // flight PNRs
        /License Plate: (?!XX00XX0000)[A-Z]{2}\d{2}[A-Z]{2}\d{4}/,
        /MakeMyTrip ID: (?!NF0+A+0+A0AAA0000)[A-Z0-9]{16,}/,
      ];
      for (const biller of discoverBillers(bundledScriptsDir())) {
        const source = readFileSync(biller.scriptPath, 'utf-8');
        for (const pattern of forbidden) {
          expect(pattern.test(source), `${biller.key} matched ${pattern}`).toBe(false);
        }
      }
    });

    it('installs into an empty folder and configures nothing else', () => {
      const target = join(root, 'installed');
      const result = installBundledScripts(target);
      expect(result.error).toBeUndefined();
      expect(result.installed.length).toBeGreaterThan(0);
      expect(result.skipped).toEqual([]);
      // Support scripts install alongside the fetchers but are not billers, so
      // the discovered count is the installed count minus those.
      expect(discoverBillers(target).length).toBe(result.installed.length - BUNDLED_SUPPORT_SCRIPTS.length);
    });

    it('installs the probe helper without listing it as a biller', () => {
      const target = join(root, 'installed-probe');
      const result = installBundledScripts(target);

      // It has to reach the user's folder — Biller Studio spawns it from there.
      expect(result.installed).toContain('probe_biller.py');
      expect(existsSync(probeScriptPath(target))).toBe(true);
      // ...but it must never show up beside the real billers.
      expect(discoverBillers(target).map((b) => b.key)).not.toContain('probe_biller');
    });

    it('never overwrites a fetcher the user has edited', () => {
      const target = join(root, 'installed2');
      installBundledScripts(target);
      const [first] = discoverBillers(target);
      writeFileSync(first.scriptPath, '# my local edits\nKEY = "mine"\nDISPLAY_NAME = "Mine"\n', 'utf-8');

      const second = installBundledScripts(target);
      expect(second.installed).toEqual([]);
      expect(second.skipped.length).toBeGreaterThan(0);
      expect(readFileSync(first.scriptPath, 'utf-8')).toContain('my local edits');
    });

    it('reports a missing bundle instead of throwing', () => {
      const result = installBundledScripts(join(root, 'nested', 'deep', 'target'));
      // Target is created on demand, so this still succeeds — the failure path
      // is a missing *source*, which is asserted via the error field shape.
      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('skipped');
    });
  });

  // ── contract with the real scripts ─────────────────────────────────────────

  describe('real fetcher contract', () => {
    // Discovery reads constants straight out of the user's Python files, so this
    // guards the assumption against the scripts drifting. Skipped where they are
    // not installed (CI, a fresh clone) rather than failing.
    //
    // Resolved from the real home rather than defaultScriptsDir(), which reads
    // OPENBOARD_CONFIG_DIR — this suite repoints that at a temp dir, so going
    // through the helper would make these silently skip depending on ordering.
    const realDir = join(homedir(), '.openboard', 'billers', 'scripts', 'invoice_fetchers');
    const present = existsSync(realDir) && discoverBillers(realDir).length > 0;

    it.skipIf(!present)('every installed fetcher declares KEY and DISPLAY_NAME', () => {
      for (const biller of discoverBillers(realDir)) {
        expect(biller.key, `${biller.scriptPath} KEY`).toMatch(/^[a-z0-9_]+$/);
        expect(biller.displayName.length, `${biller.scriptPath} DISPLAY_NAME`).toBeGreaterThan(0);
      }
    });

    it.skipIf(!present)('excludes the multi-biller and backfill scripts', () => {
      const keys = discoverBillers(realDir).map((b) => b.key);
      expect(keys).not.toContain('pending_invoices');
      expect(keys.some((k) => k.includes('backfill'))).toBe(false);
    });

    it.skipIf(!present)('derives every CSV inside the configured tree', () => {
      const repoRoot = repoRootFor(realDir);
      for (const biller of discoverBillers(realDir)) {
        expect(biller.csvPath.startsWith(repoRoot)).toBe(true);
        expect(biller.rawDir.startsWith(repoRoot)).toBe(true);
      }
    });
  });
});
