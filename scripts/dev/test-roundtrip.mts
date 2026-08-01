/**
 * Round-trip verification against live mail.
 *
 * For each biller: remove its newest CSV row and drop that message's UID from
 * state.json, then run the real fetcher and check the row comes back identical.
 *
 * This is the end-to-end proof that the new data location, the migrated
 * credential handling and each fetcher's parsing all still line up — a dry run
 * proves connectivity, but only a real append proves the row that lands is the
 * row that left.
 *
 * Touches real CSVs. Back up the invoices folder first. Values are never
 * printed; only field names, counts and match/mismatch.
 *
 * Usage: npx tsx scripts/dev/test-roundtrip.mts [key ...]
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import { BillerFetcherService } from '../../src/services/billers/BillerFetcherService.js';
import { discoverBillers } from '../../src/services/billers/BillerDiscoveryService.js';
import { runPython } from '../../src/services/billers/pythonRunner.js';

const HELPER = join(process.cwd(), 'scripts', 'dev', 'roundtrip_csv.py');

const settings = new TypedConfigRepository().getBillerSettings();
const service = new BillerFetcherService({ settings: () => settings });
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function lastJson(text: string): any {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`no JSON in output:\n${text.slice(-500)}`);
  return JSON.parse(line);
}

/** Days between an ISO email date and now, with headroom for the search window. */
function sinceDaysFor(emailDate: string): number {
  const parsed = Date.parse(emailDate);
  if (Number.isNaN(parsed)) return 400;
  const days = Math.ceil((Date.now() - parsed) / 86_400_000);
  return Math.min(1000, Math.max(7, days + 3));
}

async function roundTrip(biller: {
  key: string;
  displayName: string;
  csvPath: string;
  rawDir: string;
  scriptPath: string;
}) {
  const statePath = join(biller.rawDir, 'state.json');
  const scriptsDir = settings.scriptsDir!;

  const snipped = lastJson(
    (await runPython([HELPER, 'snip', biller.csvPath, statePath], { cwd: process.cwd(), timeoutMs: 60_000 })).stdout,
  );
  if (snipped.error) return { key: biller.key, status: `skip (${snipped.error})` };

  const sinceDays = sinceDaysFor(snipped.emailDate);
  process.stdout.write(
    `  ${biller.key.padEnd(18)} removed uid=${snipped.uid} (${snipped.rowsBefore}→${snipped.rowsAfter} rows, ` +
      `state ${snipped.removedFromState ? 'cleared' : 'unchanged'}), refetching ${sinceDays}d … `,
  );

  const expectedDir = mkdtempSync(join(tmpdir(), 'roundtrip-'));
  const expectedPath = join(expectedDir, 'expected.json');
  writeFileSync(expectedPath, JSON.stringify(snipped), 'utf-8');

  try {
    const run = await runPython(
      [biller.scriptPath, '--since-days', String(sinceDays), '--limit', '900', '--log-level', 'WARNING'],
      { cwd: scriptsDir, timeoutMs: 300_000, env: service.credentialEnv(settings) },
    );

    const verified = lastJson(
      (await runPython([HELPER, 'verify', biller.csvPath, expectedPath], { cwd: process.cwd(), timeoutMs: 60_000 }))
        .stdout,
    );

    if (!verified.restored) {
      return { key: biller.key, status: `NOT RESTORED (${verified.reason})`, log: run.output.slice(-300) };
    }
    if (!verified.identical) {
      return {
        key: biller.key,
        status: `restored but ${Object.keys(verified.differing).length} field(s) differ: ${Object.keys(verified.differing).join(', ')}`,
      };
    }
    return { key: biller.key, status: `OK — ${verified.fields} fields identical, ${verified.rows} rows` };
  } finally {
    rmSync(expectedDir, { recursive: true, force: true });
  }
}

async function main() {
  service.migrateToEnvCredentials(settings);

  const billers = discoverBillers(settings.scriptsDir).filter((b) => (wanted.length ? wanted.includes(b.key) : true));
  console.log(`Round-trip over ${billers.length} biller(s)\n`);

  const results: Array<{ key: string; status: string; log?: string }> = [];
  for (const biller of billers) {
    try {
      const result = await roundTrip(biller);
      console.log(result.status);
      results.push(result);
    } catch (error: any) {
      console.log(`ERROR ${error.message?.slice(0, 160)}`);
      results.push({ key: biller.key, status: `ERROR ${error.message?.slice(0, 160)}` });
    }
  }

  console.log('\n' + '='.repeat(66));
  for (const r of results) console.log(`  ${r.key.padEnd(18)} ${r.status}`);
  const ok = results.filter((r) => r.status.startsWith('OK')).length;
  console.log(`\n${ok}/${results.length} round-tripped cleanly.`);
}

void main();
