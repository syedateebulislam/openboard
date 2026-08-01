/**
 * Biller Studio prompts — loads the two editable Markdown prompts that drive
 * new-fetcher creation.
 *
 * Files (prompts/biller/*.md):
 *   field-detection.md    — analyse one sample email, propose fields as JSON
 *   script-generation.md  — write the biller-specific slice of a fetcher
 *
 * Same contract as dashboardPrompts.ts: reads happen once at module load and a
 * missing file degrades to a builtin fallback rather than throwing, so a
 * deleted prompt can never crash the CLI or the test suite.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dev (tsx): this file is at src/config/billerPrompts.ts → 2 levels up.
// Prod (tsup bundle): everything is in dist/index.js → 1 level up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = __dirname.includes('dist')
  ? resolve(__dirname, '..')
  : resolve(__dirname, '..', '..');
const PROMPTS_DIR = resolve(PROJECT_ROOT, 'prompts', 'biller');

/**
 * Minimal fallbacks. Deliberately terse — they only have to keep the flow
 * working long enough for the user to notice the prompt file is missing.
 */
const BUILTIN_FIELD_DETECTION =
  'Analyse this receipt email and return, between //JSON_START and //JSON_END, a JSON object with key, displayName, senderEmail, subjectPrefix, subjectKeywords, defaultSinceDays, searchLimit, and a fields array of { name, description, example, type }. Do not include source_sender, email_uid, email_subject, email_date or currency.';

const BUILTIN_SCRIPT_GENERATION =
  'Return the complete Python fetcher between //CODE_START and //CODE_END, reproducing the supplied skeleton verbatim and writing only the docstring, config constants, COLUMNS, is_receipt() and parse(). KEY and DISPLAY_NAME must be plain string literals at column 0. parse() docstrings must use synthetic values.';

function readPrompt(file: string, fallback: string): string {
  try {
    const text = readFileSync(resolve(PROMPTS_DIR, file), 'utf-8').trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** Stage 1: propose the fields a fetcher should extract from a sample email. */
export const BILLER_FIELD_DETECTION_PROMPT = readPrompt('field-detection.md', BUILTIN_FIELD_DETECTION);

/** Stage 2: write the fetcher itself. */
export const BILLER_SCRIPT_GENERATION_PROMPT = readPrompt('script-generation.md', BUILTIN_SCRIPT_GENERATION);
