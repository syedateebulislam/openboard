/**
 * Collect findings from every screen into one artefact worth reading.
 *
 * Playwright's own report says which test failed. This says what is wrong with
 * the product: one row per screen, its screenshot, and the defects found there
 * — the thing a human (or a model) reviews screen by screen.
 *
 * Written incrementally by appending JSONL, because specs run in parallel
 * workers in separate processes; a shared in-memory array would silently keep
 * only whichever worker finished last.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Finding } from './audit.js';

export const UI_OUT = join(import.meta.dirname, '..', '__screens__');
const PARTS = join(UI_OUT, '.findings');

export interface ScreenRecord {
  screen: string;
  flow: string;
  viewport: string;
  theme: string;
  screenshot: string;
  findings: Finding[];
}

export function resetReport(): void {
  mkdirSync(PARTS, { recursive: true });
  for (const file of readdirSync(PARTS)) unlinkSync(join(PARTS, file));
}

export function recordScreen(record: ScreenRecord): void {
  mkdirSync(PARTS, { recursive: true });
  // One file per worker: concurrent appends to a single file interleave.
  appendFileSync(join(PARTS, `w${process.pid}.jsonl`), `${JSON.stringify(record)}\n`, 'utf-8');
}

function readRecords(): ScreenRecord[] {
  if (!existsSync(PARTS)) return [];
  return readdirSync(PARTS)
    .flatMap((file) => readFileSync(join(PARTS, file), 'utf-8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as ScreenRecord)
    .sort((a, b) => a.screen.localeCompare(b.screen));
}

export function writeReport(): { records: ScreenRecord[]; errors: number; warnings: number } {
  const records = readRecords();
  const all = records.flatMap((record) => record.findings);
  const errors = all.filter((finding) => finding.severity === 'error').length;
  const warnings = all.filter((finding) => finding.severity === 'warning').length;

  writeFileSync(join(UI_OUT, 'ui-report.json'), JSON.stringify({ records, errors, warnings }, null, 2), 'utf-8');

  const lines: string[] = [
    '# OpenBoard UI report',
    '',
    `${records.length} screens captured · **${errors} error(s)**, ${warnings} warning(s).`,
    '',
    'Findings are machine-checked. Anything needing a human eye is the screenshot beside it.',
    '',
  ];

  const clean = records.filter((record) => record.findings.length === 0);
  const dirty = records.filter((record) => record.findings.length > 0);

  if (dirty.length > 0) {
    lines.push('## Screens with findings', '');
    for (const record of dirty) {
      lines.push(`### ${record.screen}`, '', `![${record.screen}](${toPosix(relative(UI_OUT, record.screenshot))})`, '');
      lines.push('| severity | rule | detail |', '|---|---|---|');
      for (const finding of record.findings) {
        lines.push(`| ${finding.severity} | \`${finding.rule}\` | ${escape(finding.detail)} |`);
      }
      lines.push('');
    }
  }

  lines.push('## Clean screens', '');
  lines.push(clean.length === 0 ? '_none_' : clean.map((record) => `- ${record.screen}`).join('\n'));
  lines.push('');

  writeFileSync(join(UI_OUT, 'ui-report.md'), lines.join('\n'), 'utf-8');
  return { records, errors, warnings };
}

const toPosix = (path: string) => path.split('\\').join('/');
const escape = (text: string) => text.replace(/\|/g, '\\|');
