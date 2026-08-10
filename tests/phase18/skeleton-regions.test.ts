/**
 * Phase 18 — region splicing.
 *
 * Biller Studio used to ask the model for a whole fetcher, ~78% of which was it
 * retyping helpers, the runner and the CLI already on disk. At the ~16 tok/s
 * measured on a local model that is the difference between 195s and 43s of
 * generation, and it is why a request could be severed mid-file.
 *
 * The skeletons now carry markers; the model returns only the marked bodies and
 * OpenBoardCLI splices them into its own copy. These tests pin the two properties
 * that make that safe: splicing is lossless, and a malformed skeleton or reply
 * fails loudly rather than producing a quietly broken file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRegions,
  regionNames,
  spliceRegions,
  stripRegionMarkers,
} from '../../src/services/billers/skeletonRegions.js';
import {
  assembleScript,
  missingRegions,
  outputBudgetFor,
  parseRegionResponse,
  regionsAvailable,
} from '../../src/services/billers/BillerScriptGenerator.js';
import { bundledScriptsDir } from '../../src/services/billers/BillerDiscoveryService.js';
import { scanGeneratedSource } from '../../src/services/billers/BillerScriptWriter.js';

const skeletonFor = (name: string) => readFileSync(join(bundledScriptsDir(), name), 'utf-8');

const HTML = skeletonFor('reference_html.py');
const PDF = skeletonFor('reference_pdf.py');

/** A reply in the format the prompt asks for. */
const replyFor = (skeleton: string, override: Record<string, string> = {}) =>
  parseRegions(skeleton)
    .map((r) => `//REGION:${r.name}\n${(override[r.name] ?? r.body).trimEnd()}\n//END:${r.name}`)
    .join('\n\n');

// ── the skeletons themselves ─────────────────────────────────────────────────

describe('the shipped skeletons', () => {
  it('declare the regions each one actually varies', () => {
    expect(regionNames(HTML)).toEqual(['DOCSTRING', 'CONFIG', 'COLUMNS', 'IS_RECEIPT', 'PARSE']);
    // The PDF fetcher has four custom functions beyond parse, so "five regions"
    // is not universal — the list is per-skeleton data.
    expect(regionNames(PDF)).toEqual([
      'DOCSTRING', 'CONFIG', 'COLUMNS', 'IS_RECEIPT',
      'EXTRACT_PDF_TEXT', 'PARSE_RECEIPT', 'EXTRACT_LOCATIONS', 'FETCH_PARTS',
    ]);
  });

  it('ask for far less than the whole file', () => {
    // The point of the exercise: the model stops retyping the boilerplate.
    const asked = parseRegions(HTML).reduce((n, r) => n + r.body.length, 0);
    expect(asked / HTML.length).toBeLessThan(0.25);
  });

  it('name no specific biller outside the regions', () => {
    // Whatever sits between the markers is spliced away; whatever sits outside
    // is inherited verbatim by every generated fetcher. A section banner reading
    // "Zomato-specific logic" shipped into every biller Studio produced.
    for (const [skeleton, biller] of [[HTML, 'zomato'], [PDF, 'rapido']] as const) {
      const boilerplate = spliceRegions(
        skeleton,
        new Map(regionNames(skeleton).map((n) => [n, ''])),
      );
      expect(boilerplate.toLowerCase(), biller).not.toContain(biller);
    }
  });

  it('keep the marked regions outside the shared helpers', () => {
    // REPO_ROOT and the credential path are shared; marking them would let a
    // generated fetcher redirect where OpenBoardCLI reads and writes.
    const config = parseRegions(HTML).find((r) => r.name === 'CONFIG')!;
    expect(config.body).toContain('KEY = ');
    expect(config.body).not.toContain('REPO_ROOT =');
    expect(config.body).not.toContain('CREDENTIALS_PATH =');
  });
});

// ── splicing is lossless ─────────────────────────────────────────────────────

describe('parseRegions / spliceRegions', () => {
  it('round-trips both skeletons byte for byte', () => {
    for (const [name, skeleton] of [['html', HTML], ['pdf', PDF]] as const) {
      const same = new Map(parseRegions(skeleton).map((r) => [r.name, r.body]));
      expect(spliceRegions(skeleton, same), name).toBe(skeleton);
    }
  });

  it('replaces only the named region', () => {
    const out = spliceRegions(HTML, new Map([['CONFIG', 'KEY = "other"\n']]));
    expect(out).toContain('KEY = "other"');
    expect(out).toContain('def _search_uids(');   // boilerplate untouched
    expect(out).toContain('def main(');
  });

  it('leaves regions the model omitted as the skeleton had them', () => {
    // A near-miss reply should still assemble into something judgeable.
    const out = spliceRegions(HTML, new Map([['COLUMNS', 'COLUMNS = ["a"]\n']]));
    expect(out).toContain('COLUMNS = ["a"]');
    expect(out).toContain('def parse(');
  });

  it('restores the newline a reply usually drops', () => {
    // Without this the closing marker lands on the body's last line, survives
    // the stripper, and litters the generated file.
    const out = spliceRegions(HTML, new Map([['COLUMNS', 'COLUMNS = ["a"]']]));
    expect(out).not.toMatch(/COLUMNS = \["a"\]# <</);
  });

  it('refuses a region the skeleton does not declare', () => {
    expect(() => spliceRegions(HTML, new Map([['NOPE', 'x']]))).toThrow(/No region named NOPE/);
  });
});

describe('a malformed skeleton fails loudly', () => {
  it('rejects an unpaired marker', () => {
    const broken = HTML.replace(/# <<\/OPENBOARD:COLUMNS>>\r?\n/, '');
    expect(() => parseRegions(broken)).toThrow(/unpaired or misspelled/i);
  });

  it('rejects a duplicated region', () => {
    const region = parseRegions(HTML).find((r) => r.name === 'IS_RECEIPT')!;
    const block = `# <<OPENBOARD:IS_RECEIPT>>\n${region.body}# <</OPENBOARD:IS_RECEIPT>>\n`;
    expect(() => parseRegions(HTML + '\n' + block)).toThrow(/more than once/i);
  });

  it('reports no regions for an unmarked file', () => {
    expect(parseRegions(stripRegionMarkers(HTML))).toEqual([]);
  });
});

// ── the reply format ─────────────────────────────────────────────────────────

describe('parseRegionResponse', () => {
  const expected = regionNames(HTML);

  it('reads every region back out of a well-formed reply', () => {
    const found = parseRegionResponse(replyFor(HTML), expected);
    expect([...found.keys()]).toEqual(expected);
    expect(missingRegions(expected, found)).toEqual([]);
  });

  it('tolerates a model that fences each block', () => {
    const fenced = expected
      .map((n) => `//REGION:${n}\n\`\`\`python\nbody_${n}\n\`\`\`\n//END:${n}`)
      .join('\n\n');
    const found = parseRegionResponse(fenced, expected);
    expect(found.get('PARSE')).toBe('body_PARSE');
  });

  it('names what is missing rather than saying the script was incomplete', () => {
    const partial = `//REGION:CONFIG\nKEY = "x"\n//END:CONFIG`;
    const found = parseRegionResponse(partial, expected);
    expect(missingRegions(expected, found)).toEqual(['DOCSTRING', 'COLUMNS', 'IS_RECEIPT', 'PARSE']);
  });

  it('throws when the reply has no regions at all', () => {
    expect(() => parseRegionResponse('I need more detail.', expected)).toThrow(/no marked regions/i);
  });
});

// ── assembly, fallback and the safety net ────────────────────────────────────

describe('assembleScript', () => {
  it('produces a complete fetcher with no markers left', () => {
    const out = assembleScript(replyFor(HTML), HTML);
    expect(out).not.toContain('OPENBOARD:');
    expect(out).toContain('def parse(');
    expect(out).toContain('def main(');
  });

  it('applies the model’s own content', () => {
    const out = assembleScript(replyFor(HTML, { CONFIG: 'KEY = "bigbasket"\nSEARCH_LIMIT = 50' }), HTML);
    expect(out).toContain('KEY = "bigbasket"');
  });

  it('still accepts a model that ignores the format and returns a whole file', () => {
    // Region mode is what we ask for; it must not be what the feature depends on.
    const whole = `//CODE_START\n${stripRegionMarkers(HTML)}\n//CODE_END`;
    expect(assembleScript(whole, HTML)).toContain('def parse(');
  });

  it('reports which regions were missing', () => {
    const partial = `//REGION:CONFIG\nKEY = "x"\n//END:CONFIG`;
    expect(() => assembleScript(partial, HTML)).toThrow(/did not return these regions.*PARSE/s);
  });

  it('keeps the security scan effective on the assembled file', () => {
    // The boilerplate is ours now, but a region is still model-written — the
    // guard has to see the joined result, not the reply.
    const out = assembleScript(replyFor(HTML, { PARSE: 'import socket\ndef parse(t, s):\n    return {}' }), HTML);
    expect(scanGeneratedSource(out).safe).toBe(false);
  });
});

describe('regionsAvailable', () => {
  it('is true for the shipped skeletons', () => {
    expect(regionsAvailable(HTML)).toBe(true);
    expect(regionsAvailable(PDF)).toBe(true);
  });

  it('is false — not throwing — when markers are absent or broken', () => {
    // Generation must survive a skeleton whose markers were lost; regions are
    // an optimisation, and the whole-file path still works.
    expect(regionsAvailable(stripRegionMarkers(HTML))).toBe(false);
    expect(regionsAvailable(HTML.replace(/# <<\/OPENBOARD:PARSE>>\r?\n/, ''))).toBe(false);
  });
});

describe('outputBudgetFor', () => {
  it('budgets against the regions, putting truncation out of reach', () => {
    const asked = Math.ceil(parseRegions(HTML).reduce((n, r) => n + r.body.length, 0) / 4);
    expect(outputBudgetFor(HTML)).toBeGreaterThan(asked * 3);
  });

  it('falls back to the whole file for an unmarked skeleton', () => {
    expect(outputBudgetFor(stripRegionMarkers(HTML))).toBeGreaterThanOrEqual(8192);
  });
});
