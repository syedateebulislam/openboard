/**
 * Shared types for the biller invoice-fetcher integration.
 *
 * OpenBoard does not parse invoice mail itself: it drives a folder of external,
 * per-biller Python fetchers (one dedicated `fetch_<biller>.py` per biller) that
 * read Gmail over IMAP and append rows to a per-biller CSV. OpenBoard owns
 * discovery, enablement, scheduling, and turning changed CSVs into dashboards.
 *
 * This is deliberately independent of the Gmail OAuth integration in
 * services/mail: those scripts authenticate with a Gmail App Password over
 * IMAP, which is a different credential from the OAuth client/refresh token
 * used to read the inbox as a data source. Neither feature requires the other.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoardConfig } from './board.js';

/**
 * Canonical home for the fetcher scripts.
 *
 * Nesting them under OpenBoard's own state directory keeps everything the
 * feature owns in one place, and the depth is deliberate: the scripts derive
 * their paths from `parents[2]`, so this puts their credentials at
 * <base>/billers/secrets/ and their CSVs at <base>/billers/data/invoices/
 * without a single line of the scripts needing to change.
 */
export function defaultScriptsDir(): string {
  const base = process.env.OPENBOARD_CONFIG_DIR ?? join(homedir(), '.openboard');
  return join(base, 'billers', 'scripts', 'invoice_fetchers');
}

/** One discovered per-biller fetcher script. Derived from disk, never persisted. */
export interface BillerScript {
  /** The script's own KEY constant, e.g. "swiggy_food". Used as the dashboard selector. */
  key: string;
  /** The script's own DISPLAY_NAME constant, e.g. "Swiggy Food". */
  displayName: string;
  scriptPath: string;
  /** Where the script appends rows: <repoRoot>/data/invoices/<key>.csv */
  csvPath: string;
  /** Where the script archives raw mail + its UID dedup state. */
  rawDir: string;
}

/** Biller configuration resolved with defaults applied. */
export interface BillerSettings {
  /** Folder holding the fetch_<biller>.py scripts. Unset until configured. */
  scriptsDir?: string;
  /** Gmail address the fetchers log in as. */
  email?: string;
  /** Gmail App Password (16 chars, no spaces). Stored encrypted in OpenBoard config. */
  appPassword?: string;
  /** Biller keys the user has switched on. Empty means nothing runs. */
  enabledKeys: string[];
  syncIntervalMinutes: number;
  /** How far back each fetcher searches on a run. */
  sinceDays: number;
  /**
   * When the scheduler last completed a run, persisted across sessions so a
   * launch can tell "already ran recently" from "overdue". Without this the
   * 6-hour interval would almost never elapse inside one TUI session.
   */
  lastRunAt?: string;
}

/** Outcome of running one biller's fetcher. */
export interface BillerRunResult {
  key: string;
  displayName: string;
  ok: boolean;
  /** The CSV hash changed, i.e. the fetcher actually appended rows. */
  changed: boolean;
  /** A dashboard was created or refreshed for this biller on this run. */
  dashboardUpdated?: boolean;
  error?: string;
}

export type BillerSchedulerState =
  | 'not-configured'
  | 'idle'
  | 'running'
  | 'error';

export interface BillerSchedulerStatus {
  state: BillerSchedulerState;
  lastRunAt?: string;
  nextRunAt?: string;
  /** Number of billers currently enabled. */
  enabledCount?: number;
  /** Billers whose CSV changed on the last run. */
  changedKeys?: string[];
  error?: string;
}

/**
 * Six hours, not the mail scheduler's five minutes: invoices trickle in far
 * more slowly than mail, and every changed CSV costs an LLM dashboard refresh.
 */
export const BILLERS_DEFAULT_SYNC_INTERVAL_MINUTES = 360;
export const BILLERS_DEFAULT_SINCE_DAYS = 30;
/** Per-script ceiling: an IMAP scan over a year of mail is legitimately slow. */
export const BILLER_FETCH_TIMEOUT_MS = 300_000;

/** Scripts in the fetchers folder that are not per-biller fetchers. */
export const NON_BILLER_SCRIPTS = [
  'fetch_pending_invoices.py',
  'run_backfill_invoices_new.py',
] as const;

/**
 * Board preset used when a biller's dashboard is auto-created. Keys are the
 * scripts' own KEY constants; anything unmapped falls back to 'custom'.
 */
export const BILLER_PRESET_MAP: Record<string, BoardConfig['type']> = {
  amazon: 'shopping',
  amazon_pay: 'travel',
  uber_rides: 'travel',
  rapido: 'travel',
  swiggy_food: 'food',
  swiggy_instamart: 'food',
  zomato: 'food',
  urban_company: 'utilities',
};

export function presetForBiller(key: string): BoardConfig['type'] {
  return BILLER_PRESET_MAP[key] ?? 'custom';
}
