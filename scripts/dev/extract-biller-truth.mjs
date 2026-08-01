/**
 * Pull ground truth out of the bundled fetchers so generation can be graded
 * against them.
 *
 * Each fetcher already carries a synthetic sample of the email it reads, in its
 * parse() docstring — deliberately fake values, since this folder ships to npm.
 * That makes it exactly the input Biller Studio would get from a real probe,
 * with a known-correct answer attached, and no mailbox involved.
 *
 * Dev-only helper; not shipped (scripts/dev is outside package.json "files").
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const literal = (source, name) => {
  const match = new RegExp(`^${name}\\s*=\\s*["'](.*?)["']`, 'm').exec(source);
  return match ? match[1] : '';
};

function columns(source) {
  const match = /^COLUMNS\s*=\s*\[([\s\S]*?)\]/m.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/**
 * The docstring body of parse(), minus its first summary line — the part that
 * renders the email layout.
 */
function sampleBody(source) {
  const match = /def parse\([^)]*\)[^:]*:\s*\n\s*"""([\s\S]*?)"""/.exec(source);
  if (!match) return '';

  const lines = match[1].split('\n');
  const start = lines.findIndex((line) => /body layout|layout \(/i.test(line));
  if (start === -1) return '';

  const body = lines.slice(start + 1);
  // Strip the common indent so the text looks like real get_text() output.
  const indents = body
    .filter((line) => line.trim())
    .map((line) => line.length - line.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  return body
    .map((line) => line.slice(base))
    .join('\n')
    .trim();
}

export function extractTruth(scriptsDir) {
  const results = [];
  for (const entry of readdirSync(scriptsDir).sort()) {
    if (!entry.startsWith('fetch_') || !entry.endsWith('.py')) continue;
    const source = readFileSync(join(scriptsDir, entry), 'utf-8');
    const body = sampleBody(source);
    results.push({
      file: entry,
      key: literal(source, 'KEY'),
      displayName: literal(source, 'DISPLAY_NAME'),
      senderEmail: literal(source, 'SENDER_EMAIL'),
      subjectPrefix: literal(source, 'SUBJECT_PREFIX'),
      columns: columns(source),
      // The fields a generated script has to rediscover.
      expectedFields: columns(source).filter(
        (c) => !['source_sender', 'email_uid', 'email_subject', 'email_date', 'currency'].includes(c),
      ),
      sampleBody: body,
      usable: Boolean(body),
    });
  }
  return results;
}

// Only when run directly. An `|| process.argv[2]` here would also fire when
// another script imports this one with arguments of its own.
if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('extract-biller-truth.mjs')) {
  const dir = process.argv[2] ?? join(process.cwd(), 'scripts', 'invoice_fetchers');
  for (const truth of extractTruth(dir)) {
    console.log(`\n=== ${truth.file} ===`);
    console.log(`key=${truth.key}  display=${truth.displayName}`);
    console.log(`sender=${truth.senderEmail}  subjectPrefix=${JSON.stringify(truth.subjectPrefix)}`);
    console.log(`expected fields (${truth.expectedFields.length}): ${truth.expectedFields.join(', ')}`);
    console.log(`sample body: ${truth.usable ? `${truth.sampleBody.length} chars` : 'NOT FOUND'}`);
    if (truth.usable) {
      console.log('---');
      console.log(truth.sampleBody.split('\n').slice(0, 12).join('\n'));
      console.log('---');
    }
  }
}
