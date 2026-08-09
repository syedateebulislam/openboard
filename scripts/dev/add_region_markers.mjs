/**
 * Wrap the biller-specific parts of the two reference skeletons in markers.
 *
 * Biller Studio hands the model a whole fetcher and asks for a whole fetcher
 * back, so ~78% of every generation is the model retyping helpers, the runner
 * and the CLI that are already on disk. Markers let it return only the parts
 * that differ, which OpenBoardCLI splices into its own copy.
 *
 * The markers are comments, so a marked fetcher is still ordinary Python and
 * still runs standalone.
 *
 * Dev helper; run once per skeleton. Idempotent.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const OPEN = (name) => `# <<OPENBOARD:${name}>>`;
const CLOSE = (name) => `# <</OPENBOARD:${name}>>`;

/** Wrap the first match of `pattern`, or throw so a silent miss is impossible. */
function wrap(source, name, pattern, eol) {
  if (source.includes(OPEN(name))) return source;
  const match = pattern.exec(source);
  if (!match) throw new Error(`no match for region ${name}`);
  const body = match[0];
  return source.replace(body, `${OPEN(name)}${eol}${body}${eol}${CLOSE(name)}`);
}

/**
 * A top-level def runs until the blank lines before the next def or section
 * banner. These files are CRLF, so every newline in the lookahead has to be
 * `\r?\n` — a bare `\n` matches nothing here.
 */
const untilNextTopLevel = (name) =>
  new RegExp(`^def ${name}\\([\\s\\S]*?(?=\\r?\\n\\r?\\n\\r?\\ndef |\\r?\\n\\r?\\n# ──)`, 'm');

/** Region name -> pattern matching exactly the biller-specific span. */
const REGIONS = {
  // The module docstring: everything the biller changes about how it is described.
  DOCSTRING: /^"""[\s\S]*?"""/m,
  // Only the biller's own constants — REPO_ROOT and CREDENTIALS_PATH above are
  // shared, and must stay outside the region.
  CONFIG: /^KEY = [\s\S]*?^SEARCH_LIMIT = \d+/m,
  COLUMNS: /^COLUMNS = \[[\s\S]*?^\]/m,
  IS_RECEIPT: untilNextTopLevel('is_receipt'),
  PARSE: untilNextTopLevel('parse'),
  // PDF skeleton only.
  EXTRACT_PDF_TEXT: untilNextTopLevel('extract_pdf_text'),
  PARSE_RECEIPT: untilNextTopLevel('parse_receipt'),
  EXTRACT_LOCATIONS: untilNextTopLevel('extract_locations'),
  FETCH_PARTS: untilNextTopLevel('fetch_parts'),
};

const [file, ...names] = process.argv.slice(2);
if (!file || names.length === 0) {
  console.error('usage: add_region_markers.mjs <file.py> REGION [REGION...]');
  process.exit(2);
}

let src = readFileSync(file, 'utf-8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';

for (const name of names) {
  const pattern = REGIONS[name];
  if (!pattern) throw new Error(`unknown region ${name}`);
  src = wrap(src, name, pattern, eol);
  console.log(`  marked ${name}`);
}

writeFileSync(file, src, 'utf-8');
console.log(`wrote ${file}`);
