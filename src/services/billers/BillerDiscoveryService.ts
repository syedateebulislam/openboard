/**
 * BillerDiscoveryService — find the per-biller invoice fetchers on disk.
 *
 * The scripts folder is user-configured and machine-specific (OpenBoard ships
 * on npm; these scripts do not), and the user adds new `fetch_<biller>.py`
 * files over time, so the biller list is always discovered, never hardcoded.
 *
 * Every fetcher declares its own identity as module-level constants:
 *
 *     KEY = "zomato"
 *     DISPLAY_NAME = "Zomato"
 *
 * and derives its output paths from `Path(__file__).resolve().parents[2]` —
 * two levels above the scripts folder. We mirror that convention exactly so
 * the scripts stay unmodified.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_BILLER_SCRIPTS, type BillerScript } from '../../types/billers.js';

const KEY_PATTERN = /^KEY\s*=\s*["'](.+?)["']/m;
const DISPLAY_NAME_PATTERN = /^DISPLAY_NAME\s*=\s*["'](.+?)["']/m;

/** The scripts' REPO_ROOT: two directories above the fetchers folder. */
export function repoRootFor(scriptsDir: string): string {
  return dirname(dirname(resolve(scriptsDir)));
}

/** Where every fetcher reads its Gmail IMAP credentials from. */
export function credentialsPathFor(scriptsDir: string): string {
  return join(repoRootFor(scriptsDir), 'secrets', 'gmail_app_credentials.json');
}

export interface ScriptsDirValidation {
  valid: boolean;
  error?: string;
  billers: BillerScript[];
}

/**
 * Read one fetcher's identity. Returns undefined when the file does not
 * declare both constants — which is exactly how the two non-biller scripts
 * (pending-invoices, backfill runner) exclude themselves, independent of the
 * filename denylist.
 */
export function readBillerScript(scriptPath: string, scriptsDir: string): BillerScript | undefined {
  let source: string;
  try {
    source = readFileSync(scriptPath, 'utf-8');
  } catch {
    return undefined;
  }

  const key = KEY_PATTERN.exec(source)?.[1]?.trim();
  const displayName = DISPLAY_NAME_PATTERN.exec(source)?.[1]?.trim();
  if (!key || !displayName) return undefined;

  const invoicesDir = join(repoRootFor(scriptsDir), 'data', 'invoices');
  return {
    key,
    displayName,
    scriptPath,
    csvPath: join(invoicesDir, `${key}.csv`),
    rawDir: join(invoicesDir, 'raw', key),
  };
}

/** Every per-biller fetcher in the folder, sorted by display name. */
export function discoverBillers(scriptsDir: string | undefined): BillerScript[] {
  if (!scriptsDir) return [];
  const dir = resolve(scriptsDir);
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const denied = new Set<string>(NON_BILLER_SCRIPTS);
  const found: BillerScript[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('fetch_') || !entry.endsWith('.py')) continue;
    if (denied.has(entry)) continue;
    const biller = readBillerScript(join(dir, entry), dir);
    if (biller) found.push(biller);
  }
  return found.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Validate a folder before saving it, so the UI can explain what is wrong. */
export function validateScriptsDir(scriptsDir: string): ScriptsDirValidation {
  const dir = resolve(scriptsDir);
  if (!existsSync(dir)) {
    return { valid: false, error: `Folder not found: ${dir}`, billers: [] };
  }
  try {
    if (!statSync(dir).isDirectory()) {
      return { valid: false, error: `Not a folder: ${dir}`, billers: [] };
    }
  } catch (error: any) {
    return { valid: false, error: `Cannot read folder: ${error.message}`, billers: [] };
  }

  const billers = discoverBillers(dir);
  if (billers.length === 0) {
    return {
      valid: false,
      error: 'No biller fetchers found. Expected files named fetch_<biller>.py that define KEY and DISPLAY_NAME.',
      billers: [],
    };
  }
  return { valid: true, billers };
}

/**
 * Where the fetchers that ship with OpenBoard live inside the installed package.
 *
 * Same dev-vs-bundle split as the prompt loaders, but the depth is this file's,
 * not theirs: from dist/ the package root is one level up; from
 * src/services/billers/ it is three.
 */
export function bundledScriptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = here.includes('dist')
    ? resolve(here, '..')
    : resolve(here, '..', '..', '..');
  return join(packageRoot, 'scripts', 'invoice_fetchers');
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  error?: string;
}

/**
 * Copy the bundled fetchers into a user folder. Existing files are left alone —
 * a user who has edited a fetcher must never lose that to an upgrade.
 */
export function installBundledScripts(targetDir: string): InstallResult {
  const source = bundledScriptsDir();
  if (!existsSync(source)) {
    return { installed: [], skipped: [], error: `No bundled fetchers found at ${source}.` };
  }

  const installed: string[] = [];
  const skipped: string[] = [];
  try {
    mkdirSync(targetDir, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (!entry.startsWith('fetch_') || !entry.endsWith('.py')) continue;
      const destination = join(targetDir, entry);
      if (existsSync(destination)) {
        skipped.push(entry);
        continue;
      }
      copyFileSync(join(source, entry), destination);
      installed.push(entry);
    }
  } catch (error: any) {
    return { installed, skipped, error: error.message };
  }
  return { installed, skipped };
}

/**
 * Guard against executing anything outside the configured folder: the spawned
 * path must resolve to a direct child of it.
 */
export function isInsideScriptsDir(scriptPath: string, scriptsDir: string): boolean {
  const resolved = resolve(scriptPath);
  return dirname(resolved) === resolve(scriptsDir) && basename(resolved).endsWith('.py');
}
