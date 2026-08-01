/**
 * Phase 16 — Biller Studio runtime behaviour.
 *
 * Covers the parts of the PDF round that only had indirect coverage: the
 * argument guard every spawn goes through, how PDF metadata travels from the
 * probe to the generator, the dry-run output scanner, and the probe script's
 * own CLI contract.
 *
 * The Python-dependent blocks are skipped rather than failed where no
 * interpreter exists, so the suite stays runnable everywhere while still
 * exercising the real scripts on machines that have Python.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BillerSettings } from '../../src/types/billers.js';
import { isMissingInterpreter, runPython } from '../../src/services/billers/pythonRunner.js';
import {
  BillerProbeService,
  describeProbeError,
  parseProbeOutput,
} from '../../src/services/billers/BillerProbeService.js';
import { BillerScriptWriter } from '../../src/services/billers/BillerScriptWriter.js';
import { bundledScriptsDir } from '../../src/services/billers/BillerDiscoveryService.js';
import { formatSamplePreview } from '../../src/screens/BillerStudioScreen.js';

const hasPython = (() => {
  for (const command of ['python', 'python3', 'py']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return true;
  }
  return false;
})();

let root: string;
let scriptsDir: string;

const settings = (overrides: Partial<BillerSettings> = {}): BillerSettings => ({
  scriptsDir,
  email: 'user@gmail.com',
  appPassword: 'abcdefghijklmnop',
  enabledKeys: [],
  syncIntervalMinutes: 360,
  sinceDays: 30,
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openboard-runtime-'));
  scriptsDir = join(root, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── argument guard ───────────────────────────────────────────────────────────

describe('runPython argument guard', () => {
  const options = () => ({ cwd: root, timeoutMs: 5_000 });

  it('refuses an argument with a space unless it is declared free text', async () => {
    // Caught a real bug: the grader passed an email subject straight through.
    await expect(runPython(['script.py', 'Your Zomato order'], options())).rejects.toThrow(/Unsafe argument/);
  });

  it('allows that same argument when declared', async () => {
    // Declared free text still travels as its own argv entry — crossSpawn never
    // turns on a shell, so there is nothing for it to be interpreted by.
    await expect(
      runPython(['--nonexistent-flag-xyz', 'Your Zomato order'], {
        ...options(),
        freeTextArgs: ['Your Zomato order'],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects shell metacharacters in undeclared arguments', async () => {
    for (const nasty of ['a;rm -rf /', 'a|b', 'a&&b', 'a$(whoami)', 'a`id`', 'a>out']) {
      await expect(runPython(['script.py', nasty], options())).rejects.toThrow(/Unsafe argument/);
    }
  });

  it('accepts the shapes real calls actually use', async () => {
    // Paths, flags, numbers and emails must not trip the guard.
    const safe = ['/tmp/dir/fetch_x.py', 'C:\\Users\\a\\fetch_x.py', '--since-days', '30', 'a@b.com', '-m', 'py_compile'];
    for (const arg of safe) {
      await expect(runPython([arg], { ...options(), timeoutMs: 3_000 })).resolves.toBeDefined();
    }
  });
});

describe('isMissingInterpreter', () => {
  it('recognises the ways a missing python reports itself', () => {
    expect(isMissingInterpreter(new Error('spawn python ENOENT'))).toBe(true);
    expect(isMissingInterpreter(new Error("'python' is not recognized as an internal command"))).toBe(true);
    expect(isMissingInterpreter(new Error('No such file or directory'))).toBe(true);
  });

  it('does not mistake a script error for a missing interpreter', () => {
    expect(isMissingInterpreter(new Error('SyntaxError: invalid syntax'))).toBe(false);
  });
});

// ── PDF metadata flow ────────────────────────────────────────────────────────

describe('probe output — PDF metadata', () => {
  const probeJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      matched: 1,
      scanned: 3,
      sample: {
        uid: '9',
        subject: 'Your trip',
        date: '',
        from: 'partner@rapido.bike',
        attachments: ['AUTO_RECEIPT_123.pdf'],
        bodySource: 'pdf',
        pdfSupport: true,
        text: 'Ride ID  RD123\nTotal  148.00',
        truncated: false,
        fullLength: 28,
        ...overrides,
      },
      otherSubjects: [],
      sinceDate: '01-Aug-2025',
    });

  it('carries bodySource through so the generator can switch skeletons', () => {
    const result = parseProbeOutput(probeJson());
    expect(result.sample?.bodySource).toBe('pdf');
    expect(result.sample?.pdfSupport).toBe(true);
    expect(result.sample?.attachments).toEqual(['AUTO_RECEIPT_123.pdf']);
  });

  it('reports pdfSupport false when pdfplumber is absent', () => {
    // The screen uses this to explain thin fields rather than leaving the user
    // wondering why a PDF receipt produced nothing.
    const result = parseProbeOutput(probeJson({ pdfSupport: false, bodySource: 'html', text: 'tiny' }));
    expect(result.sample?.pdfSupport).toBe(false);
  });

  it('survives an older probe that reports no bodySource at all', () => {
    const result = parseProbeOutput(probeJson({ bodySource: undefined, pdfSupport: undefined }));
    expect(result.sample).toBeTruthy();
    expect(result.sample?.bodySource).toBeUndefined();
  });
});

describe('describeProbeError', () => {
  it('explains a missing dependency with the install command', () => {
    expect(describeProbeError("ModuleNotFoundError: No module named 'bs4'")).toMatch(/pip install beautifulsoup4/);
  });

  it('explains a missing interpreter', () => {
    expect(describeProbeError('spawn python ENOENT')).toMatch(/Python was not found/i);
  });

  it('distinguishes an App Password requirement from a rejected login', () => {
    expect(describeProbeError('Application-specific password required')).toMatch(/App Password, not your normal/i);
    expect(describeProbeError('AUTHENTICATIONFAILED')).toMatch(/Gmail rejected the login/i);
  });

  it('falls back to the last meaningful line', () => {
    expect(describeProbeError('noise\n\nsomething specific went wrong')).toBe('something specific went wrong');
  });
});

// ── sample preview ───────────────────────────────────────────────────────────

describe('formatSamplePreview', () => {
  const sample = {
    uid: '1',
    subject: 'Your order from BigBasket',
    date: '2026-07-01T10:00:00',
    from: 'noreply@bigbasket.com',
    attachments: ['receipt.pdf'],
    text: 'Order ID\nBB-1\nTotal\n418.50',
    truncated: false,
    fullLength: 26,
  };

  it('shows the body, so consent is informed rather than blind', () => {
    const preview = formatSamplePreview(sample, 'Anthropic');
    expect(preview).toContain('BB-1');
    expect(preview).toContain('Order ID');
  });

  it('names the provider the text would go to', () => {
    expect(formatSamplePreview(sample, 'Anthropic')).toContain('Anthropic');
  });

  it('lists attachments and asks for an explicit yes', () => {
    const preview = formatSamplePreview(sample, 'OpenAI');
    expect(preview).toContain('receipt.pdf');
    expect(preview).toMatch(/Type "yes" to send/);
  });

  it('says how much was withheld when the body was truncated', () => {
    const preview = formatSamplePreview({ ...sample, truncated: true, fullLength: 90_000 }, 'OpenAI');
    expect(preview).toContain('90000');
  });
});

// ── dry-run output scanning ──────────────────────────────────────────────────

/** A stand-in fetcher that prints whatever the test needs and exits 0. */
function fakeFetcher(lines: string[], exitCode = 0): string {
  const path = join(scriptsDir, 'fetch_fake.py');
  const body = lines.map((line) => `print(${JSON.stringify(line)})`).join('\n');
  writeFileSync(path, `import sys\n${body}\nsys.exit(${exitCode})\n`, 'utf-8');
  return path;
}

describe.skipIf(!hasPython)('dryRun output scanning', () => {
  it('counts the rows a dry run would have written', async () => {
    const script = fakeFetcher([
      '[fake] Searching since 01-Aug-2025',
      '[fake] DRY-RUN would append row for UID 1',
      '[fake] DRY-RUN would append row for UID 2',
    ]);
    const result = await new BillerScriptWriter().dryRun(script, settings());
    expect(result.ok).toBe(true);
    expect(result.parsedRows).toBe(2);
  });

  it('fails a run that matched nothing, even though it exited 0', async () => {
    // The fetchers exit 0 on failure, so exit code alone proves nothing.
    const script = fakeFetcher(['[fake] No messages found']);
    const result = await new BillerScriptWriter().dryRun(script, settings());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parsed no rows/i);
  });

  it('treats a traceback as fatal despite a zero exit', async () => {
    const script = fakeFetcher([
      'Traceback (most recent call last):',
      '  File "fetch_fake.py", line 1',
      'ValueError: boom',
      '[fake] DRY-RUN would append row for UID 1',
    ]);
    const result = await new BillerScriptWriter().dryRun(script, settings());
    expect(result.ok).toBe(false);
  });

  it('treats a rejected login as fatal', async () => {
    const script = fakeFetcher(['[fake] Failed to connect/login to IMAP: AUTHENTICATIONFAILED']);
    const result = await new BillerScriptWriter().dryRun(script, settings());
    expect(result.ok).toBe(false);
  });

  it('fails on a non-zero exit', async () => {
    const script = fakeFetcher(['[fake] DRY-RUN would append row for UID 1'], 3);
    const result = await new BillerScriptWriter().dryRun(script, settings());
    expect(result.ok).toBe(false);
  });
});

// ── the probe script's own contract ──────────────────────────────────────────

describe.skipIf(!hasPython)('probe_biller.py CLI', () => {
  const probe = join(bundledScriptsDir(), 'probe_biller.py');

  it('reports a bad sender as JSON rather than a stack trace', async () => {
    // The caller parses one shape, so even argument errors must be JSON.
    const result = await runPython([probe, '--sender', 'not-an-address'], {
      cwd: bundledScriptsDir(),
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.error).toMatch(/not a valid email address/i);
  });

  it('imports cleanly, including the optional pdfplumber path', async () => {
    // A NameError in an annotation only shows up at import time, which is how
    // the missing Tuple import slipped past py_compile.
    const result = await runPython([probe, '--help'], { cwd: bundledScriptsDir(), timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--sender/);
    expect(result.stdout).toMatch(/--subject/);
  });

  it('exposes the knobs the probe service passes', async () => {
    const result = await runPython([probe, '--help'], { cwd: bundledScriptsDir(), timeoutMs: 30_000 });
    for (const flag of ['--since-days', '--scan-limit', '--max-chars']) {
      expect(result.stdout).toContain(flag);
    }
  });
});

describe.skipIf(!hasPython)('parse_sample.py CLI', () => {
  const helper = join(bundledScriptsDir(), 'parse_sample.py');

  it('reports a missing target as JSON', async () => {
    const result = await runPython([helper, join(root, 'nope.py'), join(root, 'nope.txt'), 'Subject'], {
      cwd: bundledScriptsDir(),
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.error).toBeTruthy();
  });

  it('reports a script with no parse() rather than crashing', async () => {
    const script = join(root, 'noparse.py');
    writeFileSync(script, 'KEY = "x"\n', 'utf-8');
    const samplePath = join(root, 'sample.txt');
    writeFileSync(samplePath, 'text', 'utf-8');

    const result = await runPython([helper, script, samplePath, 'Subject'], {
      cwd: bundledScriptsDir(),
      timeoutMs: 30_000,
    });
    expect(JSON.parse(result.stdout.trim()).error).toMatch(/no parse\(\)/i);
  });
});

// ── the probe's text extraction ──────────────────────────────────────────────

describe.skipIf(!hasPython)('probe_biller.py text extraction', () => {
  let results: any;

  beforeEach(async () => {
    const checker = join(process.cwd(), 'tests', 'fixtures', 'probe_extract_check.py');
    const probe = join(bundledScriptsDir(), 'probe_biller.py');
    const run = await runPython([checker, probe], { cwd: process.cwd(), timeoutMs: 60_000 });
    const line = run.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    if (!line) throw new Error(`extraction check produced no JSON:\n${run.output.slice(-600)}`);
    results = JSON.parse(line);
  });

  it('prefers the HTML part and flattens it the way a fetcher will see it', () => {
    // Must match BeautifulSoup(...).get_text("\n") exactly, or regexes written
    // against the sample will not match at fetch time.
    expect(results.html.source).toBe('html');
    expect(results.html.hasOrderId).toBe(true);
    expect(results.html.hasValue).toBe(true);
  });

  it('falls back to plain text when there is no HTML part', () => {
    expect(results.plain.source).toBe('text');
    expect(results.plain.hasValue).toBe(true);
  });

  it('reports no body rather than throwing on an empty email', () => {
    expect(results.empty.source).toBe('none');
    expect(results.empty.textLen).toBe(0);
  });

  it('falls back to the body when a PDF attachment cannot be read', () => {
    // A corrupt or encrypted PDF must not lose the email body with it.
    expect(results.unreadablePdf.source).toBe('html');
    expect(results.unreadablePdf.hasValue).toBe(true);
  });

  it('lists attachment filenames for the preview', () => {
    expect(results.attachments).toContain('receipt.pdf');
  });

  it('filters subjects the way the studio promises', () => {
    expect(results.subjectFilter.emptyMatchesAll).toBe(true);
    expect(results.subjectFilter.caseInsensitive).toBe(true);
    // A substring anywhere, not just a prefix — "Re: " forwards still match.
    expect(results.subjectFilter.substringAnywhere).toBe(true);
    expect(results.subjectFilter.rejectsMismatch).toBe(false);
  });
});

// ── support-script installation ──────────────────────────────────────────────

describe('probe service bootstrapping', () => {
  it('installs both helpers before probing an older folder', () => {
    // A folder configured on an earlier version has neither helper in it.
    const service = new BillerProbeService();
    service.ensureProbeScript(scriptsDir);
    expect(existsSync(join(scriptsDir, 'probe_biller.py'))).toBe(true);
    expect(existsSync(join(scriptsDir, 'parse_sample.py'))).toBe(true);
  });

  it('is safe to call repeatedly', () => {
    const service = new BillerProbeService();
    const first = service.ensureProbeScript(scriptsDir);
    expect(service.ensureProbeScript(scriptsDir)).toBe(first);
  });
});
