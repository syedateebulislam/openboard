/**
 * Grade Biller Studio's generation against the fetchers we already ship.
 *
 * Each bundled fetcher carries a synthetic sample of the email it reads in its
 * parse() docstring, plus the answer: the sender, the subject prefix and the
 * exact fields it extracts. Feeding the sample back through the Studio and
 * comparing gives an end-to-end check with a known-correct result and no
 * mailbox involved.
 *
 * This makes REAL LLM calls (two per biller, plus one per repair round) against
 * whatever provider is configured, so it is a dev script, not a test.
 *
 * It also EXECUTES the generated Python in a temp folder, which is the only way
 * to see whether the regexes extract anything. That is the same thing the
 * Studio's own dry-run does.
 *
 * Usage:
 *   npx tsx scripts/dev/test-generation.mts [key ...]      # default: zomato
 *   npx tsx scripts/dev/test-generation.mts --all
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractTruth } from './extract-biller-truth.mjs';
import { BillerScriptGenerator } from '../../src/services/billers/BillerScriptGenerator.js';
import { BillerScriptWriter } from '../../src/services/billers/BillerScriptWriter.js';
import { discoverBillers } from '../../src/services/billers/BillerDiscoveryService.js';

import type { BillerSettings } from '../../src/types/billers.js';

const REPO = process.cwd();
const FETCHERS = join(REPO, 'scripts', 'invoice_fetchers');


interface Report {
  key: string;
  proposedKey?: string;
  proposedSender?: string;
  proposedFields?: string[];
  expectedFields: string[];
  fieldRecall?: string;
  attempts?: number;
  compiled?: boolean;
  discoverable?: boolean;
  extracted?: Record<string, unknown>;
  populated?: string;
  /** How many candidates the fill-ratio gate sent back for repair. */
  gateRejections?: number;
  error?: string;
}

async function grade(truth: ReturnType<typeof extractTruth>[number]): Promise<Report> {
  const report: Report = { key: truth.key, expectedFields: truth.expectedFields };

  const workspace = mkdtempSync(join(tmpdir(), `studio-grade-${truth.key}-`));
  const scriptsDir = join(workspace, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });

  const samplePath = join(workspace, 'sample.txt');
  writeFileSync(samplePath, truth.sampleBody, 'utf-8');

  const settings: BillerSettings = {
    scriptsDir,
    email: 'grader@example.com',
    appPassword: 'gradergradergrad',
    enabledKeys: [],
    syncIntervalMinutes: 360,
    sinceDays: 30,
  };

  const sample = {
    subject: truth.subjectPrefix || `${truth.displayName} receipt`,
    from: truth.senderEmail,
    text: truth.sampleBody,
  };

  try {
    const generator = new BillerScriptGenerator();
    const writer = new BillerScriptWriter();

    // ── stage 1: field detection ────────────────────────────────────────────
    const proposal = await generator.proposeFields(sample);
    report.proposedKey = proposal.key;
    report.proposedSender = proposal.senderEmail;
    report.proposedFields = proposal.fields.map((f) => f.name);

    const hit = truth.expectedFields.filter((field) => report.proposedFields!.includes(field));
    report.fieldRecall = `${hit.length}/${truth.expectedFields.length}`;

    // ── stage 2: generation, verified by compiling and actually parsing ──────
    let attempts = 0;
    let written: string | undefined;

    await generator.generateScript(proposal, sample, {
      onAttempt: () => { attempts += 1; },
      verify: async (source) => {
        if (written) { writer.discard(written); written = undefined; }
        try {
          written = writer.write(source, proposal.key, settings);
        } catch (error: any) {
          return error.message;
        }

        const compiled = await writer.compile(written, settings);
        if (!compiled.ok) return `py_compile failed:\n${compiled.error}`;
        report.compiled = true;

        if (!writer.isDiscoverable(written, scriptsDir, proposal.key)) {
          return 'compiled but not discoverable — KEY/DISPLAY_NAME must be plain literals at column 0';
        }
        report.discoverable = true;

        // Exercise the product's own gate, so this harness grades what ships.
        const graded = await writer.parseSample(written, truth.sampleBody, sample.subject, settings);
        if (!graded.ok) {
          report.gateRejections = (report.gateRejections ?? 0) + 1;
          return graded.error;
        }

        report.extracted = graded.fields;
        report.populated = `${graded.filled?.length ?? 0}/${(graded.filled?.length ?? 0) + (graded.empty?.length ?? 0)}`;
        return undefined;
      },
    });

    report.attempts = attempts;
    report.discoverable = report.discoverable ?? false;
    // Sanity: the finished script is a real biller in a real folder.
    const found = discoverBillers(scriptsDir);
    report.discoverable = found.some((b) => b.key === proposal.key);
  } catch (error: any) {
    report.error = error.message ?? String(error);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const wanted = args.filter((a) => !a.startsWith('--'));

  const truths = extractTruth(FETCHERS)
    .filter((t) => t.usable)
    .filter((t) => (all ? true : wanted.length ? wanted.includes(t.key) : t.key === 'zomato'));

  if (truths.length === 0) {
    console.log('No matching billers with a usable sample body.');
    return;
  }

  console.log(`Grading ${truths.length} biller(s): ${truths.map((t) => t.key).join(', ')}\n`);

  const reports: Report[] = [];
  for (const truth of truths) {
    process.stdout.write(`→ ${truth.key} … `);
    const report = await grade(truth);
    reports.push(report);
    console.log(report.error ? 'FAILED' : 'ok');
  }

  console.log('\n' + '='.repeat(72));
  for (const report of reports) {
    console.log(`\n### ${report.key}`);
    if (report.error) {
      console.log(`  ERROR: ${report.error.split('\n').slice(0, 6).join('\n         ')}`);
      continue;
    }
    console.log(`  proposed key    : ${report.proposedKey}`);
    console.log(`  proposed sender : ${report.proposedSender}`);
    console.log(`  field recall    : ${report.fieldRecall}  (vs the shipped fetcher)`);
    console.log(`  proposed fields : ${report.proposedFields?.join(', ')}`);
    console.log(`  expected fields : ${report.expectedFields.join(', ')}`);
    console.log(`  attempts        : ${report.attempts}`);
    console.log(`  compiled        : ${report.compiled}`);
    console.log(`  discoverable    : ${report.discoverable}`);
    console.log(`  parsed non-empty: ${report.populated}`);
    console.log(`  extracted       : ${JSON.stringify(report.extracted, null, 2)?.split('\n').join('\n                    ')}`);
  }
  console.log('\n' + '='.repeat(72));
  const ok = reports.filter((r) => !r.error).length;
  console.log(`${ok}/${reports.length} generated a working fetcher.`);
}

void main();
