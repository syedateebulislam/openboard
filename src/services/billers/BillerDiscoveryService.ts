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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_BILLER_SCRIPTS, type BillerScript } from '../../types/billers.js';

const KEY_PATTERN = /^KEY\s*=\s*["'](.+?)["']/m;
const DISPLAY_NAME_PATTERN = /^DISPLAY_NAME\s*=\s*["'](.+?)["']/m;

/**
 * Bundled scripts that are not fetchers but still have to reach the user's
 * folder. They deliberately do not start with `fetch_`, so `discoverBillers`
 * skips them and they never appear as billers.
 */
export const BUNDLED_SUPPORT_SCRIPTS = ['probe_biller.py', 'parse_sample.py'] as const;

/** Does this filename belong in the scripts folder? */
function isInstallableScript(entry: string): boolean {
  if ((BUNDLED_SUPPORT_SCRIPTS as readonly string[]).includes(entry)) return true;
  return entry.startsWith('fetch_') && entry.endsWith('.py');
}

/** Absolute path of the probe helper inside the user's scripts folder. */
export function probeScriptPath(scriptsDir: string): string {
  return join(resolve(scriptsDir), 'probe_biller.py');
}

/** Absolute path of the parse-grading helper inside the user's scripts folder. */
export function parseSampleScriptPath(scriptsDir: string): string {
  return join(resolve(scriptsDir), 'parse_sample.py');
}

/**
 * Copy any missing support scripts into the user's folder.
 *
 * installBundledScripts never overwrites and its menu entry only appears before
 * a folder is configured, so anyone who set billers up on an earlier version
 * has a folder with no helpers in it. Without this the parse gate would find no
 * helper and wave the script through — a silently weakened check is worse than
 * a missing feature, so this runs before the Studio needs them.
 */
export function ensureSupportScripts(scriptsDir: string): string[] {
  const source = bundledScriptsDir();
  const copied: string[] = [];
  mkdirSync(resolve(scriptsDir), { recursive: true });

  for (const name of BUNDLED_SUPPORT_SCRIPTS) {
    const target = join(resolve(scriptsDir), name);
    if (existsSync(target)) continue;
    const origin = join(source, name);
    if (!existsSync(origin)) continue;
    copyFileSync(origin, target);
    copied.push(name);
  }
  return copied;
}

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
      if (!isInstallableScript(entry)) continue;
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
 * The helper that reads credentials from the environment, inserted into
 * fetchers written before OpenBoard stopped using a plaintext file.
 */
const LOAD_CREDENTIALS_HELPER = `

def load_credentials() -> dict:
    """Gmail IMAP credentials, preferring the environment over the disk.

    OpenBoard passes OPENBOARD_GMAIL_EMAIL and OPENBOARD_GMAIL_APP_PASSWORD to
    this process so the App Password never has to be written to a file. Running
    the script by hand still works: it falls back to the credentials JSON this
    fetcher has always read.
    """
    email = os.environ.get("OPENBOARD_GMAIL_EMAIL")
    app_password = os.environ.get("OPENBOARD_GMAIL_APP_PASSWORD")
    if email and app_password:
        return {"email": email, "app_password": app_password}
    return read_json(CREDENTIALS_PATH)
`;

const READ_JSON_BLOCK = `def read_json(path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
`;

/**
 * Bring one fetcher's source up to environment-based credentials.
 *
 * Returns undefined when no change is needed. Surgical on purpose: it inserts
 * one helper and redirects one call, leaving any edits the user has made to
 * parse() or the config block untouched. Replacing the whole file would be
 * simpler and would silently discard their work.
 */
export function migrateFetcherSource(source: string): string | undefined {
  const crlf = source.includes('\r\n');
  const eol = (text: string) => (crlf ? text.replaceAll('\n', '\r\n') : text);

  // Repair a fetcher damaged by the first version of this migration, which
  // rewrote the call sites *after* inserting the helper and so rewrote the
  // helper's own fallback into a call to itself. Harmless under OpenBoard,
  // which sets the environment and returns before reaching it — but a
  // standalone run would recurse until it blew the stack.
  if (/return\s+load_credentials\(\)/.test(source)) {
    return source.replace(/return\s+load_credentials\(\)/g, 'return read_json(CREDENTIALS_PATH)');
  }

  if (source.includes('def load_credentials(')) return undefined;
  if (!source.includes('read_json(CREDENTIALS_PATH)')) return undefined;

  const readJson = eol(READ_JSON_BLOCK);
  if (!source.includes(readJson)) return undefined;

  // Redirect the call sites FIRST, then insert the helper. The other order
  // catches the helper's own `return read_json(CREDENTIALS_PATH)` fallback.
  return source
    .replaceAll('read_json(CREDENTIALS_PATH)', 'load_credentials()')
    .replace(readJson, readJson + eol(LOAD_CREDENTIALS_HELPER));
}

/**
 * Upgrade every installed fetcher that still expects the plaintext credentials
 * file.
 *
 * OpenBoard <= 1.9.0 wrote secrets/gmail_app_credentials.json and the fetchers
 * read it directly. That file is now deleted on sight, so a fetcher installed
 * before the change fails on every run with FileNotFoundError. installBundled
 * Scripts cannot help: it never overwrites, precisely so hand-edited fetchers
 * survive upgrades. Hence an in-place patch instead of a recopy.
 *
 * Returns the filenames changed. Best-effort per file: one unreadable script
 * must not stop the rest from being repaired.
 */
export function migrateInstalledFetchers(scriptsDir: string | undefined): string[] {
  if (!scriptsDir) return [];
  const dir = resolve(scriptsDir);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const migrated: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('fetch_') || !entry.endsWith('.py')) continue;
    const path = join(dir, entry);
    try {
      const source = readFileSync(path, 'utf-8');
      const updated = migrateFetcherSource(source);
      if (!updated) continue;
      writeFileSync(path, updated, 'utf-8');
      migrated.push(entry);
    } catch {
      // Unreadable or read-only: leave it and carry on with the others.
    }
  }
  return migrated;
}

/**
 * Guard against executing anything outside the configured folder: the spawned
 * path must resolve to a direct child of it.
 */
export function isInsideScriptsDir(scriptPath: string, scriptsDir: string): boolean {
  const resolved = resolve(scriptPath);
  return dirname(resolved) === resolve(scriptsDir) && basename(resolved).endsWith('.py');
}
