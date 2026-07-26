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
import { tmpdir } from 'node:os';
import type { DashboardUpdateService } from '../../src/services/project/DashboardUpdateService.js';
import {
  credentialsPathFor,
  discoverBillers,
  isInsideScriptsDir,
  repoRootFor,
  validateScriptsDir,
} from '../../src/services/billers/BillerDiscoveryService.js';
import {
  BillerFetcherService,
  describeFetchError,
  hashFile,
} from '../../src/services/billers/BillerFetcherService.js';
import {
  isBillerSyncConfigured,
  msUntilDue,
  startBillerScheduler,
} from '../../src/services/billers/billerScheduler.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import {
  BILLERS_DEFAULT_SINCE_DAYS,
  BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES,
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

    it('writes the credentials file the scripts expect', () => {
      const service = new BillerFetcherService({ settings: () => settings() });
      const path = service.writeCredentialsFile();
      expect(path).toBe(credentialsPathFor(scriptsDir));
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
        email: 'user@gmail.com',
        app_password: 'abcdefghijklmnop',
      });
    });

    it('refuses to write credentials when the account is incomplete', () => {
      const service = new BillerFetcherService({ settings: () => settings({ appPassword: undefined }) });
      expect(() => service.writeCredentialsFile()).toThrow(/App Password/i);
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

    it('skips the dashboard entirely when the CSV did not change', async () => {
      mkdirSync(join(root, 'data', 'invoices'), { recursive: true });
      writeFileSync(join(root, 'data', 'invoices', 'zomato.csv'), 'order_id\n1\n', 'utf-8');

      const updateService = fakeUpdateService();
      const service = new BillerFetcherService({
        settings: () => settings(),
        updateService: updateService as unknown as DashboardUpdateService,
        // Fetcher runs but finds nothing new — file untouched.
        runScript: async () => ({ code: 0, output: '[zomato] 0 new rows' }),
      });

      const [result] = await service.syncEnabled();
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
      expect(updateService.createFromDataSource).not.toHaveBeenCalled();
      expect(updateService.updateBySelector).not.toHaveBeenCalled();
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

    it('translates the common failure modes into actionable text', () => {
      expect(describeFetchError('spawn python ENOENT')).toMatch(/Python was not found/i);
      expect(describeFetchError("ModuleNotFoundError: No module named 'pdfplumber'")).toMatch(/pdfplumber/i);
      expect(describeFetchError('imaplib.error: b\'[AUTHENTICATIONFAILED] Invalid credentials\'')).toMatch(/App Password/i);
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
  });
});
