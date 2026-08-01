/**
 * End-to-end Biller Studio run against the real mailbox.
 *
 * Uses the saved Gmail credentials to probe a live sender, then runs the whole
 * pipeline: propose fields → generate → compile → discover → grade against the
 * sample → dry-run against the mailbox.
 *
 * Values are MASKED in all output. This touches real receipts, and a terminal
 * transcript is not somewhere financial records should end up — the report
 * shows field names, whether each came back populated, and lengths, never the
 * contents. Pass --show-values to override that when debugging locally.
 *
 * Usage:
 *   npx tsx scripts/dev/test-live.mts <sender> [subject] [--show-values]
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import { BillerProbeService } from '../../src/services/billers/BillerProbeService.js';
import { BillerScriptGenerator } from '../../src/services/billers/BillerScriptGenerator.js';
import { BillerScriptWriter } from '../../src/services/billers/BillerScriptWriter.js';
import { discoverBillers } from '../../src/services/billers/BillerDiscoveryService.js';
import type { BillerSettings } from '../../src/types/billers.js';

const showValues = process.argv.includes('--show-values');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const sender = args[0];
const subject = args[1] ?? '';

/** Never print a real value; describe its shape instead. */
function mask(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (showValues) return JSON.stringify(value);
  if (typeof value === 'number') return `<number, ${String(value).length} digits>`;
  const text = String(value);
  return `<${text.length} chars>`;
}

async function main() {
  if (!sender) {
    console.log('usage: npx tsx scripts/dev/test-live.mts <sender> [subject] [--show-values]');
    return;
  }

  const saved = new TypedConfigRepository().getBillerSettings();
  if (!saved.scriptsDir || !saved.email || !saved.appPassword) {
    console.log('Biller credentials are not fully configured. Set them in Settings › Invoice fetchers.');
    return;
  }

  // Generate into a throwaway folder so the user's real fetchers are untouched.
  const workspace = mkdtempSync(join(tmpdir(), 'studio-live-'));
  const scriptsDir = join(workspace, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });

  const settings: BillerSettings = { ...saved, scriptsDir, enabledKeys: [] };

  console.log(`Probing ${sender}${subject ? ` (subject contains "${subject}")` : ''} …`);

  try {
    const probeService = new BillerProbeService();
    const probe = await probeService.probe({ sender, subject, sinceDays: 365 }, settings);

    console.log(`  matched      : ${probe.matched} (scanned ${probe.scanned} since ${probe.sinceDate})`);
    if (!probe.sample) {
      console.log('  no sample — nothing to generate from.');
      return;
    }
    console.log(`  body source  : ${probe.sample.bodySource}`);
    console.log(`  attachments  : ${probe.sample.attachments.length ? probe.sample.attachments.join(', ') : '(none)'}`);
    console.log(`  sample size  : ${probe.sample.text.length} chars${probe.sample.truncated ? ` (of ${probe.sample.fullLength})` : ''}`);
    console.log(`  subject      : <${probe.sample.subject.length} chars, masked>`);

    if (!probe.sample.text.trim()) {
      console.log('  sample body is empty — cannot generate.');
      return;
    }

    const sample = {
      subject: probe.sample.subject,
      from: probe.sample.from,
      text: probe.sample.text,
      bodySource: probe.sample.bodySource,
      pdfSupport: probe.sample.pdfSupport,
    };

    const generator = new BillerScriptGenerator();
    const writer = new BillerScriptWriter();

    console.log('\nDetecting fields …');
    const proposal = await generator.proposeFields(sample);
    console.log(`  key          : ${proposal.key}`);
    console.log(`  displayName  : ${proposal.displayName}`);
    console.log(`  sender       : ${proposal.senderEmail}`);
    console.log(`  subjectPrefix: ${JSON.stringify(proposal.subjectPrefix)}`);
    console.log(`  fields (${proposal.fields.length}) : ${proposal.fields.map((f) => f.name).join(', ')}`);

    console.log('\nGenerating …');
    let attempts = 0;
    let written: string | undefined;
    let gradeSummary = '';
    const rejections: string[] = [];

    await generator.generateScript(proposal, sample, {
      onAttempt: (n, total) => { attempts = n; console.log(`  attempt ${n}/${total}`); },
      verify: async (source) => {
        if (written) { writer.discard(written); written = undefined; }
        try {
          written = writer.write(source, proposal.key, settings);
        } catch (error: any) {
          rejections.push(`write: ${error.message}`);
          return error.message;
        }

        const compiled = await writer.compile(written, settings);
        if (!compiled.ok) { rejections.push('py_compile failed'); return `py_compile failed:\n${compiled.error}`; }
        console.log('    compiled ✓');

        if (!writer.isDiscoverable(written, scriptsDir, proposal.key)) {
          rejections.push('not discoverable');
          return 'compiled but not discoverable';
        }
        console.log('    discoverable ✓');

        const graded = await writer.parseSample(written, sample.text, sample.subject, settings);
        if (!graded.ok) {
          const short = (graded.error ?? '').split('\n')[0];
          rejections.push(`parse gate: ${short}`);
          console.log(`    parse gate ✗  ${short}`);
          return graded.error;
        }
        gradeSummary = `${graded.filled?.length ?? 0}/${(graded.filled?.length ?? 0) + (graded.empty?.length ?? 0)}`;
        console.log(`    parse gate ✓  ${gradeSummary} fields populated`);

        const dry = await writer.dryRun(written, settings);
        if (!dry.ok) {
          const short = (dry.error ?? '').split('\n')[0];
          rejections.push(`dry run: ${short}`);
          console.log(`    dry run ✗  ${short}`);
          return `The dry run failed:\n${dry.error}`;
        }
        console.log(`    dry run ✓  parsed ${dry.parsedRows} row(s) from live mail`);
        return undefined;
      },
    });

    // Re-grade for the report, masked.
    const final = await writer.parseSample(written!, sample.text, sample.subject, settings);

    console.log('\n' + '='.repeat(60));
    console.log(`RESULT: working fetcher after ${attempts} attempt(s)`);
    console.log(`  rejected candidates: ${rejections.length ? rejections.join(' | ') : 'none'}`);
    console.log(`  fields populated   : ${gradeSummary}`);
    console.log('  extracted (values masked):');
    for (const [name, value] of Object.entries(final.fields ?? {})) {
      console.log(`    ${name.padEnd(24)} ${mask(value)}`);
    }
    console.log(`  discovered as      : ${discoverBillers(scriptsDir).map((b) => b.displayName).join(', ')}`);
    console.log('='.repeat(60));
  } catch (error: any) {
    console.log(`\nFAILED: ${(error.message ?? String(error)).split('\n').slice(0, 8).join('\n        ')}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
