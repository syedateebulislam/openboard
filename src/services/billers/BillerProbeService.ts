/**
 * BillerProbeService — pull one real email so the Studio has something to learn
 * from.
 *
 * Runs the bundled probe_biller.py with the user's Gmail credentials in the
 * environment and parses the JSON it prints. The returned sample is the same
 * text a real fetcher's parse() would see, so regexes written against it match
 * at fetch time.
 *
 * The sample is real mail. It is held in memory, shown to the user, and only
 * sent anywhere after explicit confirmation — it is never logged or written to
 * disk by this service.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BillerSettings } from '../../types/billers.js';
import { BillerFetcherService } from './BillerFetcherService.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';
import { bundledScriptsDir, ensureSupportScripts, probeScriptPath } from './BillerDiscoveryService.js';
import { runPython } from './pythonRunner.js';

/** Probing opens up to 40 messages over IMAP; well under the fetch timeout. */
export const PROBE_TIMEOUT_MS = 120_000;

export interface ProbeSample {
  uid: string;
  subject: string;
  date: string;
  from: string;
  attachments: string[];
  /** Where the receipt text came from — 'pdf' switches the generator skeleton. */
  bodySource?: 'html' | 'text' | 'pdf' | 'none';
  /** False when pdfplumber is absent, so a PDF biller can explain itself. */
  pdfSupport?: boolean;
  text: string;
  truncated: boolean;
  fullLength: number;
}

export interface ProbeResult {
  matched: number;
  scanned: number;
  sample: ProbeSample | null;
  otherSubjects: string[];
  sinceDate: string;
}

export interface ProbeRequest {
  sender: string;
  subject?: string;
  sinceDays?: number;
  signal?: AbortSignal;
}

export interface BillerProbeDeps {
  settings?: () => BillerSettings;
  /** Injected in tests so no interpreter is spawned and no mailbox is touched. */
  runProbe?: (request: ProbeRequest, settings: BillerSettings) => Promise<string>;
}

/** Turn a raw probe failure into something a user can act on. */
export function describeProbeError(raw: string): string {
  const text = raw.trim();
  if (/ModuleNotFoundError: No module named ['"]?bs4/i.test(text)) {
    return 'Missing Python dependency: beautifulsoup4. Install it with `pip install beautifulsoup4`.';
  }
  if (/ENOENT|not recognized|No such file or directory/i.test(text)) {
    return 'Python was not found on PATH. Install Python 3 (or make `python` available) and try again.';
  }
  if (/Application-specific password required|WEBLOGIN required/i.test(text)) {
    return 'Gmail needs an App Password, not your normal account password. Set one in Settings › Invoice fetchers.';
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(text)) {
    return 'Gmail rejected the login. Check the address and App Password in Settings › Invoice fetchers.';
  }
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? lastLine.slice(0, 300) : 'The probe failed with no output.';
}

export class BillerProbeService {
  private readonly settings: () => BillerSettings;
  private readonly runProbeImpl?: BillerProbeDeps['runProbe'];

  constructor(deps: BillerProbeDeps = {}) {
    this.settings = deps.settings ?? (() => new TypedConfigRepository().getBillerSettings());
    this.runProbeImpl = deps.runProbe;
  }

  /**
   * Make sure probe_biller.py is present in the user's scripts folder.
   *
   * installBundledScripts never overwrites, and the "install" menu entry only
   * appears before a folder is configured — so anyone who set up billers on an
   * older version has a folder with no probe in it. Copy it on demand rather
   * than making them reinstall.
   */
  ensureProbeScript(scriptsDir: string): string {
    // Copies the parse-grading helper too: the verification gate reads it, and
    // a missing helper there would quietly skip the check.
    ensureSupportScripts(scriptsDir);

    const target = probeScriptPath(scriptsDir);
    if (!existsSync(target)) {
      throw new Error(
        `The bundled probe script is missing from this install (${join(bundledScriptsDir(), 'probe_biller.py')}).`,
      );
    }
    return target;
  }

  /** Search the mailbox and return one decoded sample email. */
  async probe(request: ProbeRequest, settings: BillerSettings = this.settings()): Promise<ProbeResult> {
    const raw = this.runProbeImpl
      ? await this.runProbeImpl(request, settings)
      : await this.spawnProbe(request, settings);

    return parseProbeOutput(raw);
  }

  private async spawnProbe(request: ProbeRequest, settings: BillerSettings): Promise<string> {
    const scriptsDir = settings.scriptsDir;
    if (!scriptsDir) throw new Error('No invoice scripts folder configured.');

    const scriptPath = this.ensureProbeScript(scriptsDir);
    const env = new BillerFetcherService({ settings: () => settings }).credentialEnv(settings);

    const subject = request.subject?.trim() ?? '';
    const args = [
      scriptPath,
      '--sender', request.sender.trim(),
      '--since-days', String(request.sinceDays ?? 365),
    ];
    if (subject) args.push('--subject', subject);

    const result = await runPython(args, {
      cwd: scriptsDir,
      timeoutMs: PROBE_TIMEOUT_MS,
      env,
      signal: request.signal,
      // A subject fragment is free text by nature — passed as its own argv
      // entry, never through a shell.
      freeTextArgs: subject ? [subject] : [],
    });

    if (!result.stdout.trim()) {
      throw new Error(describeProbeError(result.output));
    }
    return result.stdout;
  }
}

/**
 * Parse the probe's stdout.
 *
 * The script prints exactly one JSON object, but a stray warning from a
 * dependency can land on stdout ahead of it, so take the last JSON-looking
 * line rather than assuming the whole stream parses.
 */
export function parseProbeOutput(raw: string): ProbeResult {
  const line = raw
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{') && candidate.endsWith('}'))
    .pop();

  if (!line) {
    throw new Error(describeProbeError(raw));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('The probe returned output that is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The probe returned output that is not valid JSON.');
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.error === 'string') {
    throw new Error(describeProbeError(value.error));
  }

  return {
    matched: typeof value.matched === 'number' ? value.matched : 0,
    scanned: typeof value.scanned === 'number' ? value.scanned : 0,
    sample: (value.sample as ProbeSample | null) ?? null,
    otherSubjects: Array.isArray(value.otherSubjects)
      ? value.otherSubjects.filter((s): s is string => typeof s === 'string')
      : [],
    sinceDate: typeof value.sinceDate === 'string' ? value.sinceDate : '',
  };
}

export default BillerProbeService;
