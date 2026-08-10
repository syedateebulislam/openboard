/**
 * BillerFetcherService — run the external per-biller invoice fetchers and turn
 * their output into dashboards.
 *
 * One run per biller is: hash its CSV → spawn the script → hash again. An
 * unchanged hash means the fetcher found no new invoices, so the dashboard step
 * is skipped entirely and no LLM call happens. This change-gate mirrors the
 * user's existing external run_biller_cron.py, which OpenBoardCLI is replacing.
 *
 * Credentials note: the Gmail App Password is handed to each fetcher through
 * the spawned process's environment, never written to disk. It previously went
 * into a plaintext secrets/gmail_app_credentials.json, which meant a mailbox
 * credential sat unencrypted for the lifetime of the install while every other
 * secret was AES-GCM encrypted in config.json. The env var lives only as long
 * as the subprocess. Any file left by an older version is deleted on the next
 * run — see removeLegacyCredentialsFile.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { crossSpawn } from '../../utils/crossSpawn.js';
import { DashboardUpdateService } from '../project/DashboardUpdateService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';
import {
  BILLER_FETCH_TIMEOUT_MS,
  presetForBiller,
  type BillerRunResult,
  type BillerSyncResults,
  type BillerScript,
  type BillerSettings,
} from '../../types/billers.js';
import {
  credentialsPathFor,
  discoverBillers,
  isInsideScriptsDir,
  migrateInstalledFetchers,
  repoRootFor,
} from './BillerDiscoveryService.js';
import { ProjectLockService } from '../project/ProjectLockService.js';
import { toneLine } from '../../utils/logTone.js';

export type ProgressCallback = (line: string) => void;

/** Interpreters we are willing to spawn. Distinct from BuildService's npm/npx list. */
const PYTHON_COMMANDS = ['python', 'python3', 'py'] as const;

/**
 * First-dashboard builds one unattended fetch may perform.
 *
 * Removing every dashboard leaves each enabled biller needing one, and each is
 * a full LLM build plus a project build. Six enabled billers turned a routine
 * scheduled fetch into six of them back to back — twenty minutes of TUI that
 * looked hung, with nothing on screen saying that was the plan. One per run
 * makes the background loop's cost predictable; the missing tabs still arrive,
 * one per fetch, and the run says which are outstanding.
 */
export const MAX_BACKFILL_DASHBOARDS_PER_RUN = 1;
/** Only numeric/enum args ever reach argv — no user free-text is passed through. */
const SAFE_ARG = /^[A-Za-z0-9._:\\/-]+$/;

/**
 * The fetchers catch their own connection errors, log them, and still exit 0 —
 * so a rejected login is indistinguishable from "no new invoices" by exit code
 * alone. Without this, bad credentials would silently report success forever.
 * Only whole-run failures belong here; per-message problems are logged at
 * WARNING by the scripts and must not trip this.
 */
const FATAL_OUTPUT_SIGNATURES = [
  /Failed to connect\/login to IMAP/i,
  /AUTHENTICATIONFAILED/i,
  /Application-specific password required/i,
  /Traceback \(most recent call last\)/i,
  /ModuleNotFoundError/i,
];

/** A run that "succeeded" but whose output proves it did nothing useful. */
export function findFatalOutput(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => FATAL_OUTPUT_SIGNATURES.some((pattern) => pattern.test(candidate)));
  return line?.trim() || undefined;
}

export interface BillerFetcherDeps {
  settings?: () => BillerSettings;
  updateService?: DashboardUpdateService;
  /** Injected in tests so no real interpreter is spawned. */
  runScript?: (biller: BillerScript, settings: BillerSettings, onProgress?: ProgressCallback, signal?: AbortSignal) => Promise<{ code: number; output: string }>;
}

/** SHA-256 of a file, or undefined when it does not exist yet. */
export function hashFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((resolvePromise) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', () => resolvePromise(undefined));
  });
}

/**
 * Data rows in a CSV, excluding the header.
 *
 * The hash answers "did the file change"; this answers "by how much", which is
 * what the log line has to say for the number to be worth reading. Counts
 * newlines rather than parsing: a quoted field containing a newline would
 * inflate the count slightly, which is acceptable for a progress line and not
 * worth a CSV parser on every fetch.
 */
export function countCsvRows(path: string): Promise<number> {
  if (!existsSync(path)) return Promise.resolve(0);
  return new Promise((resolvePromise) => {
    let newlines = 0;
    let sawContent = false;
    createReadStream(path)
      .on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (text.length > 0) sawContent = true;
        for (const char of text) if (char === '\n') newlines += 1;
      })
      // Header line does not count, and a file without a trailing newline still
      // has one more row than it has newlines.
      .on('end', () => resolvePromise(sawContent ? Math.max(0, newlines - 1) : 0))
      .on('error', () => resolvePromise(0));
  });
}

/** Turn a raw script/spawn failure into something a user can act on. */
export function describeFetchError(raw: string): string {
  const text = raw.trim();

  // Order matters. A Python traceback ending in FileNotFoundError also contains
  // "No such file or directory", so the interpreter check below used to claim
  // Python was missing whenever a script could not open a file — which sent a
  // real credentials bug looking like a broken PATH.
  if (/FileNotFoundError.*gmail_app_credentials|gmail_app_credentials.*No such file/is.test(text)) {
    return 'This fetcher still reads the old plaintext credentials file, which OpenBoardCLI no longer creates. It will be upgraded automatically on the next run — if you keep seeing this, use "Rescan billers folder" or reinstall the bundled fetchers.';
  }
  if (/Traceback \(most recent call last\)/.test(text)) {
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop() ?? '';
    return `The fetcher crashed: ${lastLine.slice(0, 240)}`;
  }
  // Only a spawn failure means the interpreter itself is missing; by this point
  // anything matching is coming from the launcher, not from script output.
  if (/ENOENT|not recognized|No such file or directory/i.test(text)) {
    return 'Python was not found on PATH. Install Python 3 (or make `python` available) and try again.';
  }
  if (/ModuleNotFoundError: No module named ['"]?bs4/i.test(text)) {
    return 'Missing Python dependency: beautifulsoup4. Install it with `pip install beautifulsoup4`.';
  }
  if (/ModuleNotFoundError: No module named ['"]?pdfplumber/i.test(text)) {
    return 'Missing Python dependency: pdfplumber (needed by the Rapido fetcher). Install it with `pip install pdfplumber`.';
  }
  // Google's reply when a regular account password is used instead of an App
  // Password — by far the most common setup mistake, and it says nothing about
  // "authentication failed", so it needs its own branch.
  if (/Application-specific password required|WEBLOGIN required/i.test(text)) {
    return 'Gmail needs an App Password, not your normal account password. Create one at myaccount.google.com/apppasswords (16 characters) and re-enter it in Settings › Invoice fetchers.';
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(text)) {
    return 'Gmail rejected the login. Check the address and App Password in Settings › Invoice fetchers.';
  }
  if (/FileNotFoundError.*gmail_app_credentials/i.test(text)) {
    // Reaching this means the fetcher fell through to its standalone file path,
    // so it never saw the environment OpenBoardCLI sets. Usually an old copy of
    // the script that predates load_credentials().
    return 'This fetcher could not read its credentials from the environment. Reinstall the bundled fetchers from Settings › Invoice fetchers, then try again.';
  }
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? lastLine.slice(0, 300) : 'The fetcher failed with no output.';
}

export class BillerFetcherService {
  private readonly settings: () => BillerSettings;
  private readonly updateService: DashboardUpdateService;
  private readonly runScriptImpl?: BillerFetcherDeps['runScript'];

  constructor(deps: BillerFetcherDeps = {}) {
    this.settings = deps.settings ?? (() => new TypedConfigRepository().getBillerSettings());
    this.updateService = deps.updateService ?? new DashboardUpdateService();
    this.runScriptImpl = deps.runScript;
  }

  /** Billers currently discoverable, regardless of whether they are enabled. */
  list(): BillerScript[] {
    return discoverBillers(this.settings().scriptsDir);
  }

  /** Discovered billers the user has switched on. */
  listEnabled(): BillerScript[] {
    const { enabledKeys } = this.settings();
    return this.list().filter((biller) => enabledKeys.includes(biller.key));
  }

  /**
   * The credentials each fetcher reads from its environment. Validated here so
   * a missing password fails before anything is spawned, with the same message
   * the old file-writing path used.
   */
  credentialEnv(settings: BillerSettings = this.settings()): Record<string, string> {
    const { scriptsDir, email, appPassword } = settings;
    if (!scriptsDir) throw new Error('No invoice scripts folder configured.');
    if (!email || !appPassword) throw new Error('Gmail address and App Password are required.');

    return {
      OPENBOARD_GMAIL_EMAIL: email,
      OPENBOARD_GMAIL_APP_PASSWORD: appPassword,
    };
  }

  /**
   * Delete the plaintext credentials file written by OpenBoardCLI <= 1.8.0.
   *
   * Upgrading alone would otherwise leave the App Password readable on disk
   * forever: nothing reads the file any more, so nothing would ever clean it
   * up. Best-effort — a permission error here must not block a fetch.
   */
  removeLegacyCredentialsFile(settings: BillerSettings = this.settings()): boolean {
    const { scriptsDir } = settings;
    if (!scriptsDir) return false;
    const path = credentialsPathFor(scriptsDir);
    if (!existsSync(path)) return false;
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Move this install fully onto environment credentials.
   *
   * Both halves must happen together. Deleting the plaintext file while the
   * installed fetchers still read it breaks every one of them with a
   * FileNotFoundError, which is exactly what shipping only the delete did.
   *
   * Returns the fetchers that were upgraded, so the UI can say what changed.
   */
  migrateToEnvCredentials(settings: BillerSettings = this.settings()): string[] {
    const migrated = migrateInstalledFetchers(settings.scriptsDir);
    this.removeLegacyCredentialsFile(settings);
    return migrated;
  }

  /** Spawn one fetcher. Only the interpreter and numeric/enum args reach argv. */
  private async runScript(
    biller: BillerScript,
    settings: BillerSettings,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{ code: number; output: string }> {
    if (this.runScriptImpl) return this.runScriptImpl(biller, settings, onProgress, signal);

    const scriptsDir = settings.scriptsDir!;
    if (!isInsideScriptsDir(biller.scriptPath, scriptsDir)) {
      throw new Error(`Refusing to run a script outside the configured folder: ${biller.scriptPath}`);
    }

    const args = [
      biller.scriptPath,
      '--since-days', String(settings.sinceDays),
      '--log-level', 'INFO',
    ];
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe argument for the invoice fetcher: ${arg}`);
    }

    // Credentials travel in the child's environment, not on argv (which is
    // world-readable in process listings) and not on disk.
    const env = this.credentialEnv(settings);

    let lastError: Error | undefined;
    for (const command of PYTHON_COMMANDS) {
      try {
        const result = await crossSpawn(command, args, {
          cwd: scriptsDir,
          timeoutMs: BILLER_FETCH_TIMEOUT_MS,
          onProgress,
          signal,
          env,
        });
        return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
      } catch (error: any) {
        if (error?.name === 'AbortError') throw error;
        // ENOENT here means this interpreter name is absent; try the next one.
        lastError = error;
      }
    }
    throw lastError ?? new Error('No Python interpreter could be started.');
  }

  /**
   * Fetch one biller and, when its CSV actually changed, create or refresh its
   * dashboard. Unchanged output short-circuits before any LLM work.
   */
  async syncBiller(
    biller: BillerScript,
    options: {
      onProgress?: ProgressCallback;
      signal?: AbortSignal;
      skipDashboard?: boolean;
      /**
       * Whether this biller may spend a backfill — building a first dashboard
       * from data already on disk. False once the run's budget is used up; the
       * biller is reported as deferred rather than silently skipped.
       */
      allowBackfill?: boolean;
    } = {},
  ): Promise<BillerRunResult> {
    const settings = this.settings();
    const base: BillerRunResult = {
      key: biller.key,
      displayName: biller.displayName,
      ok: false,
      changed: false,
    };

    // Validate before doing any work, then make sure the script we are about to
    // run reads its credentials from the environment rather than a file that no
    // longer exists.
    try {
      this.credentialEnv(settings);
    } catch (error: any) {
      return { ...base, error: error.message };
    }
    const migrated = this.migrateToEnvCredentials(settings);
    if (migrated.length) {
      options.onProgress?.(`Upgraded ${migrated.length} fetcher(s) to environment credentials: ${migrated.join(', ')}`);
    }

    const before = await hashFile(biller.csvPath);
    const rowsBefore = await countCsvRows(biller.csvPath);
    let run: { code: number; output: string };
    try {
      run = await this.runScript(biller, settings, options.onProgress, options.signal);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      return { ...base, error: describeFetchError(error.message ?? String(error)) };
    }

    if (run.code !== 0) {
      return { ...base, error: describeFetchError(run.output) };
    }

    // Exit 0 is not proof of success: the fetchers log connection failures and
    // return normally, which would otherwise read as "no new invoices".
    const fatal = findFatalOutput(run.output);
    if (fatal) {
      return { ...base, error: describeFetchError(fatal) };
    }

    const after = await hashFile(biller.csvPath);
    const changed = Boolean(after) && before !== after;
    const existing = this.updateService.findBoard(biller.key);

    // The two lines that answer "did anything happen?", coloured so they can be
    // found without reading the fetcher output above them.
    const newRows = Math.max(0, (await countCsvRows(biller.csvPath)) - rowsBefore);
    if (changed) {
      options.onProgress?.(toneLine(
        'success',
        newRows > 0
          ? `[${biller.key}] ${newRows} new invoice${newRows === 1 ? '' : 's'}.`
          : `[${biller.key}] invoices updated.`,
      ));
    } else {
      options.onProgress?.(toneLine('muted', `[${biller.key}] no new invoices.`));
    }

    // "Unchanged" is only a reason to stop once a dashboard already exists.
    // Gating purely on `changed` meant a biller whose CSV was already populated
    // — every biller adopted from an existing setup — reported success forever
    // and never produced a tab, because the first fetch found no new mail and
    // so nothing "changed". Build it from the data already on disk instead.
    const needsFirstDashboard = Boolean(after) && !existing;
    if ((!changed && !needsFirstDashboard) || options.skipDashboard) {
      return { ...base, ok: true, changed, dashboardExists: Boolean(existing) };
    }

    // A backfill builds from rows already on disk, so it is never urgent — and
    // it is the one branch that can fire for every enabled biller at once, the
    // moment they all lack a dashboard. Bounding it per run is what stops a
    // routine fetch turning into one LLM build per biller. A biller with new
    // invoices is not bounded: that build is answering data that just arrived.
    if (needsFirstDashboard && !changed && options.allowBackfill === false) {
      options.onProgress?.(
        `[${biller.key}] has data but no dashboard yet — left for a later run.`,
      );
      return { ...base, ok: true, changed, dashboardExists: false, backfillDeferred: true };
    }

    try {
      if (needsFirstDashboard && !changed) {
        options.onProgress?.(
          `[${biller.key}] no new invoices, but no dashboard exists yet — building it from the CSV already on disk.`,
        );
      }

      const result = existing
        ? await this.updateService.updateBySelector(biller.key, options.onProgress)
        : await this.updateService.createFromDataSource(
            {
              dataFile: biller.csvPath,
              title: biller.displayName,
              type: presetForBiller(biller.key),
            },
            options.onProgress,
          );
      // Name the biller that caused the redeploy. The deploy log itself is
      // workspace-wide ("Recorded deployment on 4 board(s)"), so without this
      // there was nothing tying a redeployment to the invoices that triggered it.
      if (result.success && result.deployUrl) {
        options.onProgress?.(toneLine(
          'success',
          newRows > 0
            ? `[${biller.key}] redeployed after ${newRows} new invoice${newRows === 1 ? '' : 's'}: ${result.deployUrl}`
            : `[${biller.key}] dashboard built and deployed: ${result.deployUrl}`,
        ));
      }

      return {
        ...base,
        ok: result.success,
        changed,
        dashboardUpdated: result.success,
        dashboardExists: result.success || Boolean(existing),
        error: result.success ? undefined : result.error,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      return { ...base, ok: false, changed, dashboardExists: Boolean(existing), error: error.message };
    }
  }

  /**
   * Run every enabled biller in turn. Sequential: one IMAP account, one build
   * queue.
   *
   * Guarded by a lock on the billers root, because this has three entry points
   * — the scheduler's timer, "Fetch now" in the TUI, and `agent billers sync`
   * in a separate process. The scheduler's own re-entrancy flag only knows
   * about itself, so a manual fetch could run the same script at the same time
   * as a scheduled one: two processes appending to one CSV and rewriting the
   * same state.json, which the fetchers rewrite after every row. Last writer
   * wins, and the loser's UIDs come back as duplicates on the next run.
   */
  async syncEnabled(
    options: {
      onProgress?: ProgressCallback;
      signal?: AbortSignal;
      only?: string;
      /**
       * Called once real work is about to begin — the lock was won and there is
       * at least one biller to run.
       *
       * The schedule anchors here rather than on completion. A fetch across nine
       * billers takes minutes, and anything that ended the run in between —
       * quitting the TUI, a re-armed scheduler, pressing stop — discarded the
       * anchor for work that had already happened. The next launch then saw an
       * overdue schedule and fetched everything again, forever.
       */
      onStart?: () => void;
      /**
       * First-dashboard builds this run may perform. Defaults to
       * MAX_BACKFILL_DASHBOARDS_PER_RUN; pass Infinity for an attended run the
       * user explicitly asked for and is watching.
       */
      maxBackfillDashboards?: number;
    } = {},
  ): Promise<BillerSyncResults> {
    const settings = this.settings();
    const lockDir = settings.scriptsDir ? repoRootFor(settings.scriptsDir) : undefined;
    const lock = lockDir ? ProjectLockService.acquire(lockDir) : undefined;

    if (lock && !lock.success) {
      // A concurrent fetch is not an error — it is the lock doing its job.
      options.onProgress?.(`Skipped: another fetch is already running. ${lock.error ?? ''}`.trim());
      const skipped: BillerSyncResults = [];
      // Keep this non-enumerable so the result remains array-compatible for
      // JSON output and existing consumers that only inspect biller rows.
      Object.defineProperty(skipped, 'skipped', { value: 'locked' });
      return skipped;
    }

    try {
      const billers = options.only
        ? this.list().filter((biller) => biller.key === options.only)
        : this.listEnabled();

      // Only once there is something to do: anchoring on an empty list would
      // push the next scheduled run out by a full interval for work that never
      // happened, quietly suppressing the loop on a misconfigured setup.
      if (billers.length > 0) options.onStart?.();

      // How many first-dashboard builds this run may spend. Removing every
      // dashboard leaves all enabled billers needing one at once, which turned
      // a routine fetch into an LLM build per biller — minutes of apparently
      // hung TUI with no indication that was the plan.
      let backfillBudget = options.maxBackfillDashboards ?? MAX_BACKFILL_DASHBOARDS_PER_RUN;
      const missingDashboards = billers.filter((biller) => !this.updateService.findBoard(biller.key));
      if (missingDashboards.length > backfillBudget) {
        options.onProgress?.(
          `${missingDashboards.length} biller(s) have no dashboard yet — building ${backfillBudget} this run, ` +
          'the rest follow on later runs.',
        );
      }

      const results: BillerSyncResults = [];
      for (const biller of billers) {
        if (options.signal?.aborted) break;
        options.onProgress?.(`[${biller.key}] fetching invoices…`);
        const result = await this.syncBiller(biller, { ...options, allowBackfill: backfillBudget > 0 });
        // Only a build that actually happened costs budget. A biller with new
        // invoices is never blocked, but it still spends from the allowance, so
        // a run that has already done real build work does not also backfill.
        if (result.dashboardUpdated) backfillBudget -= 1;
        results.push(result);
      }

      const deferred = results.filter((result) => result.backfillDeferred).map((result) => result.key);
      if (deferred.length > 0) {
        options.onProgress?.(
          `Still without a dashboard: ${deferred.join(', ')}. ` +
          'Fetch again to build the next one, or run `openboard agent billers sync --biller <key>`.',
        );
      }
      return results;
    } finally {
      lock?.release();
    }
  }
}

export default BillerFetcherService;
