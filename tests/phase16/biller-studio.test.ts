/**
 * Phase 16 — Biller Studio: user-authored invoice fetchers.
 *
 * Everything external is faked. No IMAP connection, no Python interpreter, no
 * LLM call: the probe returns canned JSON, the generator takes an injected
 * provider, and verification is injected via runVerify.
 *
 * The contract that actually matters is the last one in the writer block: a
 * script this flow produces must be found by discoverBillers. A generated
 * fetcher that violates the KEY/DISPLAY_NAME convention fails silently — it
 * simply never appears in the UI — so that is pinned explicitly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BillerSettings } from '../../src/types/billers.js';
import type { LLMProvider } from '../../src/types/llm.js';
import {
  BUNDLED_SUPPORT_SCRIPTS,
  bundledScriptsDir,
  discoverBillers,
  ensureSupportScripts,
  parseSampleScriptPath,
  probeScriptPath,
} from '../../src/services/billers/BillerDiscoveryService.js';
import { parseProbeOutput } from '../../src/services/billers/BillerProbeService.js';
import {
  BillerScriptWriter,
  validateScriptSource,
} from '../../src/services/billers/BillerScriptWriter.js';
import {
  BillerScriptGenerator,
  MAX_REPAIR_ATTEMPTS,
  outputBudgetFor,
  parseGeneratedScript,
  parseProposal,
  type BillerProposal,
} from '../../src/services/billers/BillerScriptGenerator.js';
import { formatProposal } from '../../src/screens/BillerStudioScreen.js';

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

/** A minimal script that satisfies every rule the writer enforces. */
function validScript(key = 'big_basket', displayName = 'BigBasket'): string {
  return [
    '#!/usr/bin/env python3',
    '"""Standalone BigBasket invoice fetcher."""',
    'from pathlib import Path',
    '',
    'REPO_ROOT = Path(__file__).resolve().parents[2]',
    `KEY = "${key}"`,
    `DISPLAY_NAME = "${displayName}"`,
    'SENDER_EMAIL = "noreply@bigbasket.com"',
    'SUBJECT_PREFIX = "Your order"',
    'COLUMNS = ["source_sender", "email_uid", "email_subject", "email_date", "total_paid", "currency"]',
    '',
    '',
    'def parse(text, subject):',
    '    return {"total_paid": "", "currency": "INR"}',
    '',
    '',
    'def run(args):',
    '    return 0, 0',
    '',
    '',
    'def main():',
    '    return 0',
    '',
    '',
    'if __name__ == "__main__":',
    '    sys.exit(main())',
    '',
  ].join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openboard-studio-'));
  scriptsDir = join(root, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── probe output parsing ─────────────────────────────────────────────────────

describe('probe output', () => {
  const good = JSON.stringify({
    matched: 3,
    scanned: 12,
    sample: { uid: '42', subject: 'Your order', date: '', from: 'a@b.com', attachments: [], text: 'Total 100', truncated: false, fullLength: 9 },
    otherSubjects: ['Another order'],
    sinceDate: '01-Aug-2025',
  });

  it('parses a well-formed probe result', () => {
    const result = parseProbeOutput(good);
    expect(result.matched).toBe(3);
    expect(result.sample?.subject).toBe('Your order');
    expect(result.otherSubjects).toEqual(['Another order']);
  });

  it('ignores noise printed ahead of the JSON', () => {
    // A dependency warning on stdout must not break the parse.
    const result = parseProbeOutput(`UserWarning: something\n${good}`);
    expect(result.matched).toBe(3);
  });

  it('surfaces an error object as a thrown message', () => {
    expect(() => parseProbeOutput(JSON.stringify({ error: 'AUTHENTICATIONFAILED' })))
      .toThrow(/App Password|Gmail rejected/i);
  });

  it('fails clearly on output that is not JSON at all', () => {
    expect(() => parseProbeOutput('Traceback (most recent call last):\nboom')).toThrow();
  });

  it('reports no sample rather than throwing when nothing matched', () => {
    const result = parseProbeOutput(JSON.stringify({ matched: 0, scanned: 5, sample: null, otherSubjects: [], sinceDate: 'x' }));
    expect(result.sample).toBeNull();
    expect(result.matched).toBe(0);
  });
});

// ── script validation ────────────────────────────────────────────────────────

describe('script validation', () => {
  it('accepts a well-formed script', () => {
    expect(validateScriptSource(validScript(), 'big_basket').valid).toBe(true);
  });

  it('rejects a KEY that is not a plain literal', () => {
    // The discovery regex cannot read an f-string, so this would be invisible.
    const broken = validScript().replace('KEY = "big_basket"', 'KEY = f"{BILLER}"');
    const result = validateScriptSource(broken, 'big_basket');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/KEY/);
  });

  it('rejects a KEY that disagrees with the filename', () => {
    const result = validateScriptSource(validScript('other_key'), 'big_basket');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/declares KEY/);
  });

  it('rejects a missing DISPLAY_NAME', () => {
    const broken = validScript().replace(/^DISPLAY_NAME.*$/m, '');
    expect(validateScriptSource(broken, 'big_basket').valid).toBe(false);
  });

  it('rejects a REPO_ROOT at the wrong depth', () => {
    // parents[1] would put the CSV somewhere nothing reads from.
    const broken = validScript().replace('parents[2]', 'parents[1]');
    const result = validateScriptSource(broken, 'big_basket');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/parents\[2\]/);
  });

  it('rejects keys that are not lower_snake_case', () => {
    for (const key of ['BigBasket', 'big-basket', '9lives', 'big basket']) {
      expect(validateScriptSource(validScript(key), key).valid).toBe(false);
    }
  });
});

// ── writing ──────────────────────────────────────────────────────────────────

describe('BillerScriptWriter', () => {
  it('writes the script and makes it discoverable', () => {
    // This is the contract the whole feature turns on.
    const writer = new BillerScriptWriter();
    const path = writer.write(validScript(), 'big_basket', settings());

    expect(path).toBe(join(scriptsDir, 'fetch_big_basket.py'));
    expect(writer.isDiscoverable(path, scriptsDir, 'big_basket')).toBe(true);

    const found = discoverBillers(scriptsDir);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('big_basket');
    expect(found[0].displayName).toBe('BigBasket');
    expect(found[0].csvPath).toBe(writer.csvPathFor(scriptsDir, 'big_basket'));
  });

  it('refuses to overwrite an existing fetcher', () => {
    const writer = new BillerScriptWriter();
    writer.write(validScript(), 'big_basket', settings());
    // A user may have hand-edited theirs; clobbering it would be unrecoverable.
    expect(() => writer.write(validScript(), 'big_basket', settings())).toThrow(/already exists/i);
  });

  it('refuses to write an invalid script at all', () => {
    const writer = new BillerScriptWriter();
    const broken = validScript().replace('parents[2]', 'parents[1]');
    expect(() => writer.write(broken, 'big_basket', settings())).toThrow();
    expect(existsSync(join(scriptsDir, 'fetch_big_basket.py'))).toBe(false);
  });

  it('refuses to write when no scripts folder is configured', () => {
    const writer = new BillerScriptWriter();
    expect(() => writer.write(validScript(), 'big_basket', settings({ scriptsDir: undefined }))).toThrow(/folder/i);
  });

  it('discards a script without disturbing its neighbours', () => {
    const writer = new BillerScriptWriter();
    const keep = writer.write(validScript('keep_me', 'KeepMe'), 'keep_me', settings());
    const drop = writer.write(validScript('drop_me', 'DropMe'), 'drop_me', settings());

    writer.discard(drop);
    expect(existsSync(drop)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(discoverBillers(scriptsDir).map((b) => b.key)).toEqual(['keep_me']);
  });
});

// ── the fill-ratio gate ──────────────────────────────────────────────────────

/**
 * These run the real parse_sample.py, so they need an interpreter. Skipped
 * rather than failed where Python is absent — the gate is exercised for real in
 * CI images that have it, and the rest of the suite must stay hermetic.
 */
const hasPython = (() => {
  for (const command of ['python', 'python3', 'py']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return true;
  }
  return false;
})();

/** A fetcher whose parse() returns exactly the values it is told to. */
function scriptReturning(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `        "${name}": ${JSON.stringify(value)},`)
    .join('\n');
  return [
    '#!/usr/bin/env python3',
    '"""Standalone Fixture invoice fetcher."""',
    'from pathlib import Path',
    '',
    'REPO_ROOT = Path(__file__).resolve().parents[2]',
    'KEY = "fixture"',
    'DISPLAY_NAME = "Fixture"',
    `COLUMNS = ["source_sender", "email_uid", "email_subject", "email_date", ${Object.keys(fields).map((f) => `"${f}"`).join(', ')}, "currency"]`,
    '',
    '',
    'def parse(text, subject):',
    '    return {',
    body,
    '        "currency": "INR",',
    '    }',
    '',
    '',
    'def run(args):',
    '    return 0, 0',
    '',
    '',
    'def main():',
    '    return 0',
    '',
    '',
    'if __name__ == "__main__":',
    '    raise SystemExit(main())',
    '',
  ].join('\n');
}

describe.skipIf(!hasPython)('field fill gate', () => {
  const gradeWith = async (fields: Record<string, string>) => {
    const writer = new BillerScriptWriter();
    const path = writer.write(scriptReturning(fields), 'fixture', settings());
    return writer.parseSample(path, 'irrelevant sample text', 'Subject', settings());
  };

  it('passes a fetcher that fills everything', async () => {
    const result = await gradeWith({ order_id: 'A1', total_paid: '99', items: 'x' });
    expect(result.ok).toBe(true);
    expect(result.filled).toEqual(['order_id', 'total_paid', 'items']);
    expect(result.empty).toEqual([]);
  });

  it('rejects the 1-of-5 case that used to pass', async () => {
    // The old bar was "at least one non-empty field", which let a fetcher
    // through with four of five blank.
    const result = await gradeWith({ a: 'filled', b: '', c: '', d: '', e: '' });
    expect(result.ok).toBe(false);
    expect(result.empty).toEqual(['b', 'c', 'd', 'e']);
    expect(result.error).toMatch(/only filled 1 of 5/i);
  });

  it('names the empty fields so the repair prompt can target them', async () => {
    const result = await gradeWith({ order_id: 'A1', total_paid: '', taxes: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('total_paid');
    expect(result.error).toContain('taxes');
  });

  it('tolerates one legitimately absent field out of several', async () => {
    // A missing discount on a given receipt must not fail an otherwise good
    // fetcher, which is why the bar is two thirds rather than everything.
    const result = await gradeWith({ a: '1', b: '2', c: '3', d: '' });
    expect(result.ok).toBe(true);
  });

  it('does not let hardcoded currency inflate the ratio', async () => {
    // Every fetcher hardcodes currency, so counting it would score a fetcher
    // that extracted nothing at all as 1/1.
    const result = await gradeWith({ order_id: '', total_paid: '' });
    expect(result.ok).toBe(false);
    expect(result.filled).toEqual([]);
  });

  it('counts a zero amount as extracted', async () => {
    // 0.00 is a real value on a receipt with no delivery fee.
    const writer = new BillerScriptWriter();
    const source = scriptReturning({ fee: 'PLACEHOLDER' }).replace('"PLACEHOLDER"', '0');
    const path = writer.write(source, 'fixture', settings());
    const result = await writer.parseSample(path, 'text', 'Subject', settings());
    expect(result.ok).toBe(true);
    expect(result.filled).toEqual(['fee']);
  });

  it('reports a parse() that raises instead of counting it as empty', async () => {
    const writer = new BillerScriptWriter();
    const source = scriptReturning({ a: 'x' }).replace(
      'def parse(text, subject):',
      'def parse(text, subject):\n    raise ValueError("boom")\n',
    );
    const path = writer.write(source, 'fixture', settings());
    const result = await writer.parseSample(path, 'text', 'Subject', settings());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parse\(\) raised.*boom/i);
  });

  it('leaves no sample file behind', async () => {
    await gradeWith({ a: '1', b: '2', c: '3' });
    const leftovers = readdirSync(scriptsDir).filter((f) => f.startsWith('.sample-'));
    expect(leftovers).toEqual([]);
  });
});

// ── LLM response parsing ─────────────────────────────────────────────────────

describe('proposal parsing', () => {
  const proposalJson = {
    key: 'big_basket',
    displayName: 'BigBasket',
    senderEmail: 'noreply@bigbasket.com',
    subjectPrefix: 'Your order',
    subjectKeywords: ['order'],
    defaultSinceDays: 30,
    searchLimit: 100,
    fields: [
      { name: 'order_id', description: 'Order number', example: 'BB-1', type: 'string' },
      { name: 'total_paid', description: 'Total', example: '418.50', type: 'amount' },
    ],
    notes: '',
  };

  it('parses a marked JSON block', () => {
    const proposal = parseProposal(`chatter\n//JSON_START\n${JSON.stringify(proposalJson)}\n//JSON_END\ntrailing`);
    expect(proposal.key).toBe('big_basket');
    expect(proposal.fields).toHaveLength(2);
    expect(proposal.fields[1].type).toBe('amount');
  });

  it('tolerates a model that wraps the JSON in a fence', () => {
    const proposal = parseProposal(`//JSON_START\n\`\`\`json\n${JSON.stringify(proposalJson)}\n\`\`\`\n//JSON_END`);
    expect(proposal.key).toBe('big_basket');
  });

  it('drops reserved columns the runner adds itself', () => {
    // A duplicate email_uid would collide when the row is assembled.
    const withReserved = {
      ...proposalJson,
      fields: [...proposalJson.fields, { name: 'email_uid', description: 'x', example: 'y', type: 'string' }],
    };
    const proposal = parseProposal(JSON.stringify(withReserved));
    expect(proposal.fields.map((f) => f.name)).toEqual(['order_id', 'total_paid']);
  });

  it('rejects an unusable key', () => {
    expect(() => parseProposal(JSON.stringify({ ...proposalJson, key: 'Big Basket' }))).toThrow(/lower_snake_case/i);
  });

  it('rejects a proposal with no fields left', () => {
    expect(() => parseProposal(JSON.stringify({ ...proposalJson, fields: [] }))).toThrow(/no usable fields/i);
  });

  it('rejects output that is not JSON', () => {
    expect(() => parseProposal('I could not analyse that email.')).toThrow(/valid JSON/i);
  });
});

describe('script extraction', () => {
  it('pulls the file out of the code markers', () => {
    const response = `here you go\n//CODE_START\n${validScript()}\n//CODE_END\nhope that helps`;
    const code = parseGeneratedScript(response);
    expect(code).toContain('def parse(');
    expect(code).not.toContain('hope that helps');
  });

  it('tolerates a fenced reply without markers', () => {
    expect(parseGeneratedScript(`\`\`\`python\n${validScript()}\n\`\`\``)).toContain('def parse(');
  });

  it('rejects a reply with no script in it', () => {
    expect(() => parseGeneratedScript('I need more information about the email.')).toThrow(/complete fetcher/i);
  });
});

// ── generation + repair loop ─────────────────────────────────────────────────

/** A provider that replays canned responses in order. */
function stubProvider(responses: string[]): LLMProvider & { calls: number } {
  const provider = {
    name: 'stub',
    calls: 0,
    validate: async () => ({ valid: true }),
    listModels: async () => ['stub-model'],
    complete: async () => {
      const response = responses[Math.min(provider.calls, responses.length - 1)];
      provider.calls += 1;
      return response;
    },
    stream: async function* () {
      yield { text: '', done: true };
    },
  };
  return provider as unknown as LLMProvider & { calls: number };
}

const proposal: BillerProposal = {
  key: 'big_basket',
  displayName: 'BigBasket',
  senderEmail: 'noreply@bigbasket.com',
  subjectPrefix: 'Your order',
  subjectKeywords: ['order'],
  defaultSinceDays: 30,
  searchLimit: 100,
  fields: [{ name: 'total_paid', description: 'Total', example: '418.50', type: 'amount' }],
  notes: '',
};

const sample = { subject: 'Your order', from: 'noreply@bigbasket.com', text: 'Grand Total\n418.50' };

describe('BillerScriptGenerator', () => {
  it('returns the script when the first attempt verifies', async () => {
    const provider = stubProvider([`//CODE_START\n${validScript()}\n//CODE_END`]);
    const generator = new BillerScriptGenerator({ provider });

    const source = await generator.generateScript(proposal, sample, { verify: async () => undefined });
    expect(source).toContain('def parse(');
    expect(provider.calls).toBe(1);
  });

  it('retries when verification reports a failure, then succeeds', async () => {
    const provider = stubProvider([
      `//CODE_START\n${validScript()}\n//CODE_END`,
      `//CODE_START\n${validScript()}\n//CODE_END`,
    ]);
    const generator = new BillerScriptGenerator({ provider });

    let attempt = 0;
    const source = await generator.generateScript(proposal, sample, {
      verify: async () => {
        attempt += 1;
        return attempt === 1 ? 'py_compile failed: bad indent' : undefined;
      },
    });

    expect(source).toContain('def parse(');
    expect(provider.calls).toBe(2);
  });

  it('retries a structurally invalid script without calling verify', async () => {
    const invalid = validScript().replace('parents[2]', 'parents[1]');
    const provider = stubProvider([
      `//CODE_START\n${invalid}\n//CODE_END`,
      `//CODE_START\n${validScript()}\n//CODE_END`,
    ]);
    const generator = new BillerScriptGenerator({ provider });

    let verifyCalls = 0;
    await generator.generateScript(proposal, sample, {
      verify: async () => { verifyCalls += 1; return undefined; },
    });

    // The first candidate never reached verification — it was rejected locally.
    expect(verifyCalls).toBe(1);
    expect(provider.calls).toBe(2);
  });

  it('gives up after the repair budget and reports the last failure', async () => {
    const provider = stubProvider([`//CODE_START\n${validScript()}\n//CODE_END`]);
    const generator = new BillerScriptGenerator({ provider });

    await expect(
      generator.generateScript(proposal, sample, { verify: async () => 'still broken' }),
    ).rejects.toThrow(/still broken/);

    expect(provider.calls).toBe(MAX_REPAIR_ATTEMPTS + 1);
  });

  it('reports attempt numbers so the UI can show progress', async () => {
    const provider = stubProvider([`//CODE_START\n${validScript()}\n//CODE_END`]);
    const generator = new BillerScriptGenerator({ provider });
    const seen: number[] = [];

    await expect(
      generator.generateScript(proposal, sample, {
        onAttempt: (attempt) => seen.push(attempt),
        verify: async () => 'nope',
      }),
    ).rejects.toThrow();

    expect(seen).toEqual([1, 2, 3]);
  });

  it('builds a prompt from the real bundled fetcher', () => {
    // The reference is read from disk rather than hardcoded, so the template
    // the model copies cannot drift from the fetchers actually shipped.
    const generator = new BillerScriptGenerator({ provider: stubProvider(['']) });
    const reference = generator.referenceScript();
    expect(reference).toContain('def run(args)');
    expect(reference).toContain('KEY = "zomato"');
  });
});

// ── bundled assets ───────────────────────────────────────────────────────────

describe('bundled support scripts', () => {
  it('all ship alongside the fetchers', () => {
    for (const name of BUNDLED_SUPPORT_SCRIPTS) {
      expect(existsSync(join(bundledScriptsDir(), name)), name).toBe(true);
    }
  });

  it('are not discovered as billers', () => {
    // They must never appear in the biller list; the name is what excludes them.
    for (const name of BUNDLED_SUPPORT_SCRIPTS) {
      writeFileSync(join(scriptsDir, name), readFileSync(join(bundledScriptsDir(), name), 'utf-8'));
    }
    expect(discoverBillers(scriptsDir)).toEqual([]);
  });

  it('are installed on demand into a folder that predates them', () => {
    // installBundledScripts never overwrites and its menu entry only shows
    // before a folder exists, so an older setup would otherwise never get them.
    expect(existsSync(probeScriptPath(scriptsDir))).toBe(false);
    const copied = ensureSupportScripts(scriptsDir);
    expect(copied).toEqual([...BUNDLED_SUPPORT_SCRIPTS]);
    expect(existsSync(probeScriptPath(scriptsDir))).toBe(true);
    expect(existsSync(parseSampleScriptPath(scriptsDir))).toBe(true);
  });

  it('does not recopy what is already there', () => {
    ensureSupportScripts(scriptsDir);
    expect(ensureSupportScripts(scriptsDir)).toEqual([]);
  });
});

// ── output budget ────────────────────────────────────────────────────────────

describe('outputBudgetFor', () => {
  it('scales with the reference so a large skeleton is not truncated', () => {
    // A flat 8192 silently cut off the 14 KB PDF skeleton mid-file; the budget
    // has to leave room for the whole reference plus reasoning.
    const small = outputBudgetFor('x'.repeat(12_000));
    const large = outputBudgetFor('x'.repeat(14_000));
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(14_000 / 4);
  });

  it('never drops below the old floor', () => {
    expect(outputBudgetFor('short')).toBeGreaterThanOrEqual(8192);
  });

  it('is capped so a pathological reference cannot ask for everything', () => {
    expect(outputBudgetFor('x'.repeat(5_000_000))).toBeLessThanOrEqual(32_000);
  });
});

describe('reference selection', () => {
  it('uses the PDF fetcher when the receipt came from an attachment', () => {
    const generator = new BillerScriptGenerator({ provider: stubProvider(['']) });
    const pdf = generator.referenceScript('pdf');
    const html = generator.referenceScript('html');
    expect(pdf).toContain('pdfplumber');
    expect(html).not.toContain('pdfplumber');
    // Rapido is the only shipped fetcher that reads PDFs.
    expect(pdf).toContain('KEY = "rapido"');
  });

  it('defaults to the HTML fetcher', () => {
    const generator = new BillerScriptGenerator({ provider: stubProvider(['']) });
    expect(generator.referenceScript()).toContain('KEY = "zomato"');
  });
});

describe('truncation reporting', () => {
  it('says the script was cut off rather than blaming the format', () => {
    // A generic "did not return a complete script" sent a real PDF failure
    // down the wrong path for three attempts.
    const partial = `//CODE_START\n${'# padding\n'.repeat(80)}def run(args):\n    return 0, 0\n`;
    expect(() => parseGeneratedScript(partial)).toThrow(/cut off|ran out of output budget/i);
  });

  it('still reports a prose reply as a missing script', () => {
    expect(() => parseGeneratedScript('I need more detail about the email.')).toThrow(/complete fetcher/i);
  });

  it('rejects a script that stops before its CLI entry point', () => {
    const noMain = [
      '//CODE_START',
      'KEY = "x"',
      'def parse(text, subject):',
      '    return {}',
      '//CODE_END',
    ].join('\n');
    expect(() => parseGeneratedScript(noMain)).toThrow(/cut off mid-file/i);
  });
});

// ── presentation ─────────────────────────────────────────────────────────────

describe('formatProposal', () => {
  it('shows each field with the value found in the sample', () => {
    const text = formatProposal(proposal);
    expect(text).toContain('BigBasket');
    expect(text).toContain('big_basket');
    expect(text).toContain('total_paid');
    expect(text).toContain('418.50');
  });

  it('describes keyword matching when there is no subject prefix', () => {
    const text = formatProposal({ ...proposal, subjectPrefix: '', subjectKeywords: ['receipt'] });
    expect(text).toMatch(/keywords/i);
    expect(text).toContain('receipt');
  });
});
