/**
 * BillerFetcherService — run the external per-biller invoice fetchers and turn
 * their output into dashboards.
 *
 * One run per biller is: materialize the credentials file the script expects →
 * hash its CSV → spawn the script → hash again. An unchanged hash means the
 * fetcher found no new invoices, so the dashboard step is skipped entirely and
 * no LLM call happens. This change-gate mirrors the user's existing external
 * run_biller_cron.py, which OpenBoard is replacing.
 *
 * Credentials note: the JSON written for the scripts is necessarily plaintext —
 * the Python fetchers have no way to decrypt anything. OpenBoard's own copy in
 * config.json stays encrypted; this file is written 0600 as the best available
 * protection. See the security section in the docs.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { crossSpawn } from '../../utils/crossSpawn.js';
import { DashboardUpdateService } from '../project/DashboardUpdateService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';
import {
  BILLER_FETCH_TIMEOUT_MS,
  presetForBiller,
  type BillerRunResult,
  type BillerScript,
  type BillerSettings,
} from '../../types/billers.js';
import {
  credentialsPathFor,
  discoverBillers,
  isInsideScriptsDir,
} from './BillerDiscoveryService.js';

export type ProgressCallback = (line: string) => void;

/** Interpreters we are willing to spawn. Distinct from BuildService's npm/npx list. */
const PYTHON_COMMANDS = ['python', 'python3', 'py'] as const;
/** Only numeric/enum args ever reach argv — no user free-text is passed through. */
const SAFE_ARG = /^[A-Za-z0-9._:\\/-]+$/;

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

/** Turn a raw script/spawn failure into something a user can act on. */
export function describeFetchError(raw: string): string {
  const text = raw.trim();
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
    return 'The fetcher could not find its credentials file. Re-enter the email and App Password to rewrite it.';
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
   * Write the credentials JSON where every fetcher looks for it. Called before
   * each run so an updated password takes effect immediately.
   */
  writeCredentialsFile(settings: BillerSettings = this.settings()): string {
    const { scriptsDir, email, appPassword } = settings;
    if (!scriptsDir) throw new Error('No invoice scripts folder configured.');
    if (!email || !appPassword) throw new Error('Gmail address and App Password are required.');

    const path = credentialsPathFor(scriptsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ email, app_password: appPassword }, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
    return path;
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

    let lastError: Error | undefined;
    for (const command of PYTHON_COMMANDS) {
      try {
        const result = await crossSpawn(command, args, {
          cwd: scriptsDir,
          timeoutMs: BILLER_FETCH_TIMEOUT_MS,
          onProgress,
          signal,
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
    options: { onProgress?: ProgressCallback; signal?: AbortSignal; skipDashboard?: boolean } = {},
  ): Promise<BillerRunResult> {
    const settings = this.settings();
    const base: BillerRunResult = {
      key: biller.key,
      displayName: biller.displayName,
      ok: false,
      changed: false,
    };

    try {
      this.writeCredentialsFile(settings);
    } catch (error: any) {
      return { ...base, error: error.message };
    }

    const before = await hashFile(biller.csvPath);
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

    const after = await hashFile(biller.csvPath);
    const changed = Boolean(after) && before !== after;
    if (!changed || options.skipDashboard) {
      return { ...base, ok: true, changed };
    }

    // The CSV grew: create the dashboard on first data, refresh it afterwards.
    try {
      const existing = this.updateService.findBoard(biller.key);
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
      return {
        ...base,
        ok: result.success,
        changed: true,
        dashboardUpdated: result.success,
        error: result.success ? undefined : result.error,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      return { ...base, ok: false, changed: true, error: error.message };
    }
  }

  /** Run every enabled biller in turn. Sequential: one IMAP account, one build queue. */
  async syncEnabled(
    options: { onProgress?: ProgressCallback; signal?: AbortSignal; only?: string } = {},
  ): Promise<BillerRunResult[]> {
    const billers = options.only
      ? this.list().filter((biller) => biller.key === options.only)
      : this.listEnabled();

    const results: BillerRunResult[] = [];
    for (const biller of billers) {
      if (options.signal?.aborted) break;
      options.onProgress?.(`[${biller.key}] fetching invoices…`);
      results.push(await this.syncBiller(biller, options));
    }
    return results;
  }
}

export default BillerFetcherService;
