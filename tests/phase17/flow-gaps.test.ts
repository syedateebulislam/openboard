/**
 * Phase 17 — flow gaps found in the end-to-end audit.
 *
 * Each block pins one behaviour that was wrong in a way nothing surfaced:
 * a biller that reported success forever without producing a dashboard, a
 * deployment that never got recorded anywhere, two entry points that could run
 * the same fetcher at once, and data that quietly stopped refreshing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BillerSettings } from '../../src/types/billers.js';
import type { BoardConfig } from '../../src/types/board.js';
import {
  boardsNeedingDeployRecord,
  type DashboardUpdateService,
} from '../../src/services/project/DashboardUpdateService.js';
import { BillerFetcherService } from '../../src/services/billers/BillerFetcherService.js';
import { stalePronedDataKeys } from '../../src/services/billers/BillerDiscoveryService.js';

let root: string;
let scriptsDir: string;
let invoicesDir: string;

const settings = (overrides: Partial<BillerSettings> = {}): BillerSettings => ({
  scriptsDir,
  email: 'user@gmail.com',
  appPassword: 'abcdefghijklmnop',
  enabledKeys: ['zomato'],
  syncIntervalMinutes: 360,
  sinceDays: 30,
  ...overrides,
});

/** Minimal discoverable fetcher. */
function installFetcher(key: string, displayName: string): void {
  writeFileSync(
    join(scriptsDir, `fetch_${key}.py`),
    [
      'from pathlib import Path',
      'REPO_ROOT = Path(__file__).resolve().parents[2]',
      `KEY = "${key}"`,
      `DISPLAY_NAME = "${displayName}"`,
      'def parse(text, subject):\n    return {}',
      'def run(args):\n    return 0, 0',
    ].join('\n'),
    'utf-8',
  );
}

function writeCsv(key: string, rows = 3): void {
  mkdirSync(invoicesDir, { recursive: true });
  const lines = ['source_sender,email_uid,total_paid'];
  for (let i = 0; i < rows; i++) lines.push(`${key},${100 + i},${10 * (i + 1)}`);
  writeFileSync(join(invoicesDir, `${key}.csv`), lines.join('\n') + '\n', 'utf-8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openboard-gaps-'));
  scriptsDir = join(root, 'scripts', 'invoice_fetchers');
  invoicesDir = join(root, 'data', 'invoices');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(invoicesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── C1: a populated CSV with no dashboard ────────────────────────────────────

describe('first dashboard for a biller that already has data', () => {
  /** An update service that records what it was asked to do. */
  function fakeUpdateService(boardExists: boolean) {
    return {
      findBoard: vi.fn(() => (boardExists ? { id: 'b1', name: 'zomato' } : undefined)),
      createFromDataSource: vi.fn(async () => ({ success: true })),
      updateBySelector: vi.fn(async () => ({ success: true })),
    };
  }

  it('creates one even when the fetch found nothing new', async () => {
    // The gate used to be `if (!changed) return`, so a biller adopted with a
    // populated CSV reported ok forever and never produced a tab.
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');

    const updateService = fakeUpdateService(false);
    const service = new BillerFetcherService({
      settings: () => settings(),
      updateService: updateService as unknown as DashboardUpdateService,
      runScript: async () => ({ code: 0, output: 'no new messages' }),
    });

    const [result] = await service.syncEnabled();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(updateService.createFromDataSource).toHaveBeenCalledTimes(1);
    expect(result.dashboardUpdated).toBe(true);
    expect(result.dashboardExists).toBe(true);
  });

  it('does not rebuild when the data is unchanged and a dashboard exists', async () => {
    // The original gate is still right for the steady state: no new mail and a
    // dashboard already there means there is nothing to do.
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');

    const updateService = fakeUpdateService(true);
    const service = new BillerFetcherService({
      settings: () => settings(),
      updateService: updateService as unknown as DashboardUpdateService,
      runScript: async () => ({ code: 0, output: 'no new messages' }),
    });

    const [result] = await service.syncEnabled();
    expect(result.ok).toBe(true);
    expect(updateService.createFromDataSource).not.toHaveBeenCalled();
    expect(updateService.updateBySelector).not.toHaveBeenCalled();
    expect(result.dashboardExists).toBe(true);
  });

  it('does not invent a dashboard when there is no data at all', async () => {
    // No CSV means nothing to build from; the run is a clean no-op.
    installFetcher('zomato', 'Zomato');

    const updateService = fakeUpdateService(false);
    const service = new BillerFetcherService({
      settings: () => settings(),
      updateService: updateService as unknown as DashboardUpdateService,
      runScript: async () => ({ code: 0, output: 'no messages' }),
    });

    const [result] = await service.syncEnabled();
    expect(result.ok).toBe(true);
    expect(updateService.createFromDataSource).not.toHaveBeenCalled();
    expect(result.dashboardExists).toBe(false);
  });

  it('reports dashboardExists so an agent can tell a no-op from a dead end', async () => {
    // `ok: true, changed: false` is identical in both cases without this.
    installFetcher('zomato', 'Zomato');

    const service = new BillerFetcherService({
      settings: () => settings(),
      updateService: fakeUpdateService(false) as unknown as DashboardUpdateService,
      runScript: async () => ({ code: 0, output: 'nothing' }),
    });

    const [result] = await service.syncEnabled();
    expect(result).toHaveProperty('dashboardExists', false);
  });
});

// ── C2: concurrent fetch ─────────────────────────────────────────────────────

describe('concurrent fetch protection', () => {
  it('skips the run when another fetch already holds the lock', async () => {
    // The scheduler's own re-entrancy flag never saw "Fetch now" or the CLI, so
    // two processes could append to one CSV and rewrite one state.json.
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');

    let concurrent = 0;
    let maxConcurrent = 0;
    const makeService = () =>
      new BillerFetcherService({
        settings: () => settings(),
        updateService: {
          findBoard: () => ({ id: 'b1' }),
          createFromDataSource: async () => ({ success: true }),
          updateBySelector: async () => ({ success: true }),
        } as unknown as DashboardUpdateService,
        runScript: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 60));
          concurrent--;
          return { code: 0, output: 'ok' };
        },
      });

    const [first, second] = await Promise.all([
      makeService().syncEnabled(),
      makeService().syncEnabled(),
    ]);

    expect(maxConcurrent).toBe(1);
    // One of the two is turned away; the other does the work.
    const ran = [first, second].filter((r) => r.length > 0);
    const skipped = [first, second].filter((r) => r.length === 0);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('releases the lock so the next run is not blocked forever', async () => {
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');

    const service = () =>
      new BillerFetcherService({
        settings: () => settings(),
        updateService: {
          findBoard: () => ({ id: 'b1' }),
          createFromDataSource: async () => ({ success: true }),
          updateBySelector: async () => ({ success: true }),
        } as unknown as DashboardUpdateService,
        runScript: async () => ({ code: 0, output: 'ok' }),
      });

    expect(await service().syncEnabled()).toHaveLength(1);
    expect(await service().syncEnabled()).toHaveLength(1);
  });

  it('releases the lock even when a fetch throws', async () => {
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');

    const exploding = new BillerFetcherService({
      settings: () => settings(),
      runScript: async () => { throw Object.assign(new Error('stop'), { name: 'AbortError' }); },
    });
    await expect(exploding.syncEnabled()).rejects.toThrow();

    // A lock left behind by a crashed run would wedge the scheduler.
    const after = new BillerFetcherService({
      settings: () => settings(),
      updateService: {
        findBoard: () => ({ id: 'b1' }),
        createFromDataSource: async () => ({ success: true }),
        updateBySelector: async () => ({ success: true }),
      } as unknown as DashboardUpdateService,
      runScript: async () => ({ code: 0, output: 'ok' }),
    });
    expect(await after.syncEnabled()).toHaveLength(1);
  });
});

// ── A1: recording a deployment ───────────────────────────────────────────────

describe('boardsNeedingDeployRecord', () => {
  const board = (name: string, outputDir: string, extra: Partial<BoardConfig> = {}): BoardConfig =>
    ({
      id: name, name, title: name, type: 'custom', outputDir,
      dataFiles: [], components: [], createdAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }) as BoardConfig;

  it('records against every board sharing the workspace, not just one', () => {
    // 13 dashboards in one project meant 12 read "never deployed" while live.
    const boards = [
      board('a', '/w/one'),
      board('b', '/w/one'),
      board('c', '/w/two'),
    ];
    const targeted = boardsNeedingDeployRecord(boards, '/w/one', 'https://x.vercel.app');
    expect(targeted.map((b) => b.name)).toEqual(['a', 'b']);
  });

  it('normalises the path so separators and trailing slashes still match', () => {
    const boards = [board('a', join('/w', 'one'))];
    expect(boardsNeedingDeployRecord(boards, join('/w', 'one', '.'), 'https://x')).toHaveLength(1);
  });

  it('skips boards already carrying this exact deployment', () => {
    const boards = [
      board('a', '/w/one', { deployUrl: 'https://x', lastDeployed: '2026-01-01T00:00:00.000Z' }),
      board('b', '/w/one'),
    ];
    expect(boardsNeedingDeployRecord(boards, '/w/one', 'https://x').map((b) => b.name)).toEqual(['b']);
  });

  it('re-records when the URL changed', () => {
    const boards = [board('a', '/w/one', { deployUrl: 'https://old', lastDeployed: 'x' })];
    expect(boardsNeedingDeployRecord(boards, '/w/one', 'https://new')).toHaveLength(1);
  });

  it('records a board that has a URL but no timestamp', () => {
    // Half-written state should be completed, not treated as done.
    const boards = [board('a', '/w/one', { deployUrl: 'https://x' })];
    expect(boardsNeedingDeployRecord(boards, '/w/one', 'https://x')).toHaveLength(1);
  });
});

// ── C3: data nothing maintains ───────────────────────────────────────────────

describe('stalePronedDataKeys', () => {
  it('names CSVs that no fetcher keeps current', () => {
    // These render a dashboard that looks healthy and never changes again.
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');
    writeCsv('apple');
    writeCsv('anthropic');

    expect(stalePronedDataKeys(scriptsDir)).toEqual(['anthropic', 'apple']);
  });

  it('ignores the pending_invoices aggregate, which is not a biller', () => {
    installFetcher('zomato', 'Zomato');
    writeCsv('zomato');
    writeCsv('pending_invoices');

    expect(stalePronedDataKeys(scriptsDir)).toEqual([]);
  });

  it('returns nothing when every CSV has a fetcher', () => {
    installFetcher('zomato', 'Zomato');
    installFetcher('uber_rides', 'Uber Rides');
    writeCsv('zomato');
    writeCsv('uber_rides');

    expect(stalePronedDataKeys(scriptsDir)).toEqual([]);
  });

  it('is quiet when nothing is configured', () => {
    expect(stalePronedDataKeys(undefined)).toEqual([]);
    expect(stalePronedDataKeys(join(root, 'nope'))).toEqual([]);
  });
});
