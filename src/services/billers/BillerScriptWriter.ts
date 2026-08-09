/**
 * BillerScriptWriter — validate, write and prove a generated fetcher.
 *
 * TemplateService.writeGeneratedFile cannot be reused here: its allowlist only
 * permits .tsx/.ts/.css inside a dashboard project, and these are .py files in
 * the user's scripts folder. So this owns its own validation.
 *
 * The checks matter more than usual because the worst failure is silent. A
 * script whose KEY is an f-string, or that sits in a subfolder, is simply never
 * discovered — no error, no log line, the biller just never appears. Every rule
 * below exists to turn one of those silent failures into a message.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BillerSettings } from '../../types/billers.js';
import { BillerFetcherService } from './BillerFetcherService.js';
import {
  bundledScriptsDir,
  ensureSupportScripts,
  isInsideScriptsDir,
  parseSampleScriptPath,
  readBillerScript,
  repoRootFor,
} from './BillerDiscoveryService.js';
import { runPython } from './pythonRunner.js';

/** Discovery requires lower_snake_case; it becomes the CSV filename too. */
export const BILLER_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Every module the shipped fetchers import, and nothing else.
 *
 * This list is the security boundary of the whole Studio. A fetcher is written
 * by an LLM from the text of an email, and an email is attacker-controlled
 * input: anyone who can send you mail can put instructions in a receipt. The
 * generated script is then compiled, imported and run — the dry run with the
 * Gmail App Password in its environment — so "the model probably won't comply"
 * is not a control. Denying the model the tools to reach the network or spawn
 * a process is.
 *
 * Derived from the imports actually present in the eight bundled fetchers.
 */
export const ALLOWED_PYTHON_MODULES = new Set([
  'argparse', 'csv', 'datetime', 'email', 'imaplib', 'io', 'json',
  'logging', 'os', 're', 'sys', 'pathlib', 'typing', 'collections',
  'decimal', 'html', 'string', 'textwrap', 'unicodedata',
  // Third-party, both already required by shipped fetchers.
  'bs4', 'pdfplumber',
]);

/**
 * Constructs that are dangerous even when every import is allowed.
 *
 * `os` has to be permitted (the fetchers use os.path and os.makedirs), which
 * leaves its process-spawning surface reachable — hence the explicit denials
 * rather than relying on the import list alone.
 */
const DENIED_CONSTRUCTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bos\s*\.\s*(system|popen|exec[lv]?[pe]*|spawn\w*|fork|kill)\s*\(/, reason: 'os process execution' },
  { pattern: /\bsubprocess\b/, reason: 'subprocess' },
  { pattern: /\bsocket\b/, reason: 'raw sockets' },
  { pattern: /\b(urllib|requests|httpx|aiohttp|http\.client|ftplib|smtplib|telnetlib)\b/, reason: 'outbound network' },
  // re.compile is legitimate and ubiquitous here; bare compile() is not.
  { pattern: /(?<!re\s*\.\s*)\bcompile\s*\(/, reason: 'compile()' },
  { pattern: /\beval\s*\(/, reason: 'eval()' },
  { pattern: /\bexec\s*\(/, reason: 'exec()' },
  { pattern: /__import__|\bimportlib\b/, reason: 'dynamic import' },
  { pattern: /\b(pickle|marshal|shelve|dill)\b/, reason: 'deserialisation' },
  { pattern: /\b(shutil|ctypes|multiprocessing|threading)\b/, reason: 'system access' },
  { pattern: /\bbase64\b/, reason: 'base64 (obfuscation vector; no fetcher needs it)' },
  { pattern: /\bsetattr\s*\(\s*__builtins__/, reason: 'builtins tampering' },
  // Only the two variables OpenBoardCLI sets may be read. load_credentials() in
  // the skeleton needs them; anything else in the environment (other API keys,
  // tokens from the parent process) is none of a fetcher's business.
  { pattern: /\bos\s*\.\s*environ\b/, reason: 'reading environment variables other than its own credentials' },
];

/** The two reads load_credentials() is expected to make. */
const ALLOWED_ENV_READS =
  /os\s*\.\s*environ\s*\.\s*get\s*\(\s*["']OPENBOARD_GMAIL_(?:EMAIL|APP_PASSWORD)["']\s*\)/g;

/** Top-level module of an import line: `email.header` → `email`. */
function rootModule(name: string): string {
  return name.trim().split('.')[0];
}

/**
 * Collect every module a script imports.
 *
 * Deliberately line-based rather than a Python parse: anything this misses is
 * caught by DENIED_CONSTRUCTS, and a regex cannot be tricked into executing
 * the input the way a real interpreter could.
 */
export function importedModules(source: string): string[] {
  const modules = new Set<string>();

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;

    const from = /^from\s+([\w.]+)\s+import\s+/.exec(line);
    if (from) {
      modules.add(rootModule(from[1]));
      continue;
    }

    const plain = /^import\s+(.+)$/.exec(line);
    if (plain) {
      // `import a, b as c` — take each name, drop any alias.
      for (const part of plain[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) modules.add(rootModule(name));
      }
    }
  }

  return [...modules];
}

export interface SourceScan {
  safe: boolean;
  violations: string[];
}

/**
 * Reject generated code that reaches beyond what a fetcher needs.
 *
 * Runs before the script is written, so nothing unsafe is ever placed on disk,
 * let alone executed. Mirrors the frontend scan in ProjectManager.preDeployChecks.
 *
 * Residual risk this does not cover: a script may still write files, because
 * writing the CSV is its entire job. Without network or process access the
 * blast radius of that is local and inspectable.
 */
export function scanGeneratedSource(source: string): SourceScan {
  const violations: string[] = [];

  for (const module of importedModules(source)) {
    if (!ALLOWED_PYTHON_MODULES.has(module)) {
      violations.push(`imports "${module}", which no invoice fetcher needs`);
    }
  }

  // Blank out the sanctioned credential reads so the broad os.environ denial
  // below catches only the ones that are not part of the skeleton.
  const scannable = source.replace(ALLOWED_ENV_READS, 'OPENBOARD_CREDENTIAL_READ');

  for (const { pattern, reason } of DENIED_CONSTRUCTS) {
    if (pattern.test(scannable)) violations.push(`uses ${reason}`);
  }

  return { safe: violations.length === 0, violations };
}

/** Compiling is fast; a dry-run opens a mailbox, so it gets the longer budget. */
const COMPILE_TIMEOUT_MS = 60_000;
const DRY_RUN_TIMEOUT_MS = 180_000;

/** Rows to pull during verification — enough to prove parsing, few enough to stay quick. */
export const DRY_RUN_LIMIT = 3;

/**
 * How much of the proposed field set must actually come back populated.
 *
 * "At least one non-empty field" was the original bar and it was far too low:
 * grading against the shipped fetchers produced a script that filled 2 of 6
 * fields and still passed. A user would have saved that and only discovered
 * the blanks days later, in the dashboard. Two thirds leaves room for fields
 * that are legitimately absent from a given receipt (a discount, a tip) while
 * still rejecting regexes that broadly missed.
 */
export const MIN_FIELD_FILL_RATIO = 0.66;

export interface SampleParseResult {
  ok: boolean;
  error?: string;
  fields?: Record<string, unknown>;
  filled?: string[];
  empty?: string[];
  ratio?: number;
}

/** A value that counts as extracted. 0 is a real amount; "" and null are not. */
function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export interface ScriptValidation {
  valid: boolean;
  errors: string[];
}

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, in a form worth feeding back to the LLM for repair. */
  error?: string;
  /** Raw stdout+stderr of the dry run, for display. */
  output?: string;
  parsedRows?: number;
}

/**
 * Check a generated script against everything discovery and the runner assume.
 *
 * Pure — no filesystem writes — so the Studio can validate a proposal before
 * committing it, and tests can exercise it without a temp dir.
 */
export function validateScriptSource(source: string, key: string): ScriptValidation {
  const errors: string[] = [];

  if (!BILLER_KEY_PATTERN.test(key)) {
    errors.push(`Key "${key}" must be lower_snake_case (letters, digits and underscores, starting with a letter).`);
  }

  // These two mirror BillerDiscoveryService's own regexes exactly. If they do
  // not match there, the fetcher is invisible in the UI with no error at all.
  if (!/^KEY\s*=\s*["'](.+?)["']/m.test(source)) {
    errors.push('The script must declare KEY = "..." as a plain string literal at the start of a line.');
  } else {
    const declared = /^KEY\s*=\s*["'](.+?)["']/m.exec(source)?.[1];
    if (declared !== key) {
      errors.push(`The script declares KEY = "${declared}" but the file is named for "${key}".`);
    }
  }

  if (!/^DISPLAY_NAME\s*=\s*["'](.+?)["']/m.test(source)) {
    errors.push('The script must declare DISPLAY_NAME = "..." as a plain string literal at the start of a line.');
  }

  if (!/^COLUMNS\s*=/m.test(source)) {
    errors.push('The script must declare a COLUMNS list.');
  }

  if (!/def\s+parse\s*\(/.test(source)) {
    errors.push('The script must define parse().');
  }

  if (!/def\s+run\s*\(/.test(source)) {
    errors.push('The script must define run().');
  }

  // The runner derives every output path from parents[2]; a script that
  // computes them differently writes its CSV where nothing will look for it.
  if (!/parents\[2\]/.test(source)) {
    errors.push('REPO_ROOT must be Path(__file__).resolve().parents[2], as every other fetcher does.');
  }

  return { valid: errors.length === 0, errors };
}

export interface BillerScriptWriterDeps {
  /** Injected in tests so no interpreter runs. */
  runVerify?: (scriptPath: string, settings: BillerSettings, mode: 'compile' | 'dry-run') => Promise<VerifyResult>;
}

export class BillerScriptWriter {
  private readonly runVerifyImpl?: BillerScriptWriterDeps['runVerify'];

  constructor(deps: BillerScriptWriterDeps = {}) {
    this.runVerifyImpl = deps.runVerify;
  }

  /** Where a fetcher for `key` would live. */
  pathFor(scriptsDir: string, key: string): string {
    return join(resolve(scriptsDir), `fetch_${key}.py`);
  }

  /**
   * Write the script, after validating it and confirming nothing is overwritten.
   *
   * Refusing to overwrite matches installBundledScripts, which never clobbers a
   * fetcher the user may have edited by hand.
   */
  write(source: string, key: string, settings: BillerSettings): string {
    const scriptsDir = settings.scriptsDir;
    if (!scriptsDir) throw new Error('No invoice scripts folder configured.');

    // Content first: a script that reaches the network or spawns a process must
    // never touch the disk, because everything after this point runs it.
    const scan = scanGeneratedSource(source);
    if (!scan.safe) {
      throw new Error(
        `Refusing to save this fetcher — the generated code ${scan.violations.join('; ')}. ` +
          'An invoice fetcher only reads mail and writes a CSV. This can happen if the ' +
          'sample email contained instructions aimed at the model; try a different message ' +
          'from the same sender, or a narrower subject filter.',
      );
    }

    const validation = validateScriptSource(source, key);
    if (!validation.valid) {
      throw new Error(validation.errors.join(' '));
    }

    const target = this.pathFor(scriptsDir, key);
    if (!isInsideScriptsDir(target, scriptsDir)) {
      throw new Error(`Refusing to write outside the configured folder: ${target}`);
    }
    if (existsSync(target)) {
      throw new Error(`A fetcher named fetch_${key}.py already exists. Choose a different key or remove it first.`);
    }

    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
    return target;
  }

  /** Remove a script written by this flow — used when verification fails. */
  discard(scriptPath: string): void {
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      // Best-effort: a locked file must not mask the verification error that
      // caused us to roll back in the first place.
    }
  }

  /** Syntax check. Catches the majority of generation defects in ~1s. */
  async compile(scriptPath: string, settings: BillerSettings): Promise<VerifyResult> {
    if (this.runVerifyImpl) return this.runVerifyImpl(scriptPath, settings, 'compile');

    const result = await runPython(['-m', 'py_compile', scriptPath], {
      cwd: settings.scriptsDir!,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      return { ok: false, error: result.output.trim().slice(-1500), output: result.output };
    }
    return { ok: true, output: result.output };
  }

  /**
   * Run the new fetcher's parse() over the sample it was written from.
   *
   * This is the gate that catches a script which compiles, connects, and still
   * returns nothing but blanks — the failure a dry run cannot see, because the
   * fetchers log "would append row" whether or not the row has any content.
   * Deterministic and offline: same text in, same fields out.
   */
  async parseSample(
    scriptPath: string,
    sampleText: string,
    subject: string,
    settings: BillerSettings,
  ): Promise<SampleParseResult> {
    const scriptsDir = settings.scriptsDir!;

    // Install the helper if it is not there yet. Returning "ok" on a missing
    // helper was the original behaviour and it meant the gate quietly passed
    // everything — a check that disables itself is worse than no check, since
    // the output looks identical to a real pass.
    ensureSupportScripts(scriptsDir);
    const helper = parseSampleScriptPath(scriptsDir);
    if (!existsSync(helper)) {
      throw new Error(
        `parse_sample.py is missing from this install (${parseSampleScriptPath(bundledScriptsDir())}), so a generated fetcher cannot be graded.`,
      );
    }

    // The sample is a real receipt. It goes to a private temp directory, not
    // the user's scripts folder: a crash between write and cleanup would
    // otherwise strand somebody's mail in a directory they browse and back up.
    const sampleDir = mkdtempSync(join(tmpdir(), 'openboard-sample-'));
    const samplePath = join(sampleDir, 'sample.txt');
    writeFileSync(samplePath, sampleText, 'utf-8');

    try {
      const result = await runPython([helper, scriptPath, samplePath, subject], {
        cwd: scriptsDir,
        timeoutMs: COMPILE_TIMEOUT_MS,
        freeTextArgs: [subject],
      });

      const line = result.stdout
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.startsWith('{'))
        .pop();
      if (!line) return { ok: false, error: `parse() produced no output:\n${result.output.trim().slice(-800)}` };

      const parsed = JSON.parse(line) as { fields?: Record<string, unknown>; error?: string };
      if (parsed.error) return { ok: false, error: parsed.error };

      const fields = parsed.fields ?? {};
      // currency is hardcoded by every fetcher, so counting it would inflate
      // the ratio on a script that extracted nothing at all.
      const graded = Object.entries(fields).filter(([name]) => name !== 'currency');
      const filled = graded.filter(([, value]) => isPopulated(value)).map(([name]) => name);
      const empty = graded.filter(([, value]) => !isPopulated(value)).map(([name]) => name);
      const ratio = graded.length ? filled.length / graded.length : 0;

      if (ratio < MIN_FIELD_FILL_RATIO) {
        return {
          ok: false,
          fields,
          filled,
          empty,
          ratio,
          error:
            `parse() ran but only filled ${filled.length} of ${graded.length} fields ` +
            `(needs ${Math.ceil(MIN_FIELD_FILL_RATIO * graded.length)}).\n\n` +
            `Empty: ${empty.join(', ')}\n` +
            `Filled: ${filled.join(', ') || '(none)'}\n\n` +
            'Rewrite the patterns for the empty fields. Remember the sample has ' +
            'the label and its value on separate lines, so a pattern needs an ' +
            'explicit \\n between them. Give each field two or three alternative ' +
            'labels via find_first.',
        };
      }

      return { ok: true, fields, filled, empty, ratio };
    } finally {
      try {
        rmSync(sampleDir, { recursive: true, force: true });
      } catch {
        // A leftover temp sample is harmless; never mask the result over it.
      }
    }
  }

  /**
   * Run the new fetcher against the real mailbox without writing anything.
   *
   * This is the check that actually matters: a script can compile perfectly and
   * still extract nothing, because the regexes were written against a layout
   * assumption that turned out to be wrong.
   */
  async dryRun(scriptPath: string, settings: BillerSettings, signal?: AbortSignal): Promise<VerifyResult> {
    if (this.runVerifyImpl) return this.runVerifyImpl(scriptPath, settings, 'dry-run');

    const env = new BillerFetcherService({ settings: () => settings }).credentialEnv(settings);
    const result = await runPython(
      [
        scriptPath,
        '--dry-run',
        '--limit', String(DRY_RUN_LIMIT),
        '--since-days', String(settings.sinceDays),
        '--log-level', 'INFO',
      ],
      { cwd: settings.scriptsDir!, timeoutMs: DRY_RUN_TIMEOUT_MS, env, signal },
    );

    const output = result.output;

    // The fetchers catch connection errors and still exit 0, so exit code alone
    // proves nothing — the same reason BillerFetcherService scans output.
    const fatal = /Traceback \(most recent call last\)|ModuleNotFoundError|AUTHENTICATIONFAILED|Failed to connect\/login to IMAP/i;
    if (result.code !== 0 || fatal.test(output)) {
      return { ok: false, error: output.trim().slice(-1500), output };
    }

    const parsedRows = (output.match(/DRY-RUN would append row/g) ?? []).length;
    if (parsedRows === 0) {
      return {
        ok: false,
        error: `The fetcher ran but parsed no rows from any matching email.\n\n${output.trim().slice(-1200)}`,
        output,
        parsedRows: 0,
      };
    }

    return { ok: true, output, parsedRows };
  }

  /**
   * Confirm the written script is actually discoverable — the end-to-end check
   * that the whole feature turns on.
   */
  isDiscoverable(scriptPath: string, scriptsDir: string, key: string): boolean {
    const biller = readBillerScript(scriptPath, resolve(scriptsDir));
    return biller?.key === key;
  }

  /** Where this biller's CSV will land once it runs for real. */
  csvPathFor(scriptsDir: string, key: string): string {
    return join(repoRootFor(scriptsDir), 'data', 'invoices', `${key}.csv`);
  }
}

export default BillerScriptWriter;
