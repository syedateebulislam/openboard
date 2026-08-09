/**
 * Pixel-diff a captured screen against its accepted baseline.
 *
 * The audit catches defects it knows how to describe. This catches the rest:
 * anything that *changed*. A card that silently lost its border, a chart whose
 * colours inverted, a heading that moved — no assertion enumerates those, but a
 * diff shows them immediately.
 *
 * Deliberately forgiving on the first run: a missing baseline is seeded rather
 * than failed. A suite whose very first run is red teaches people to pass
 * `--update` reflexively, and after that nobody reads the diffs at all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Finding } from './audit.js';

/**
 * Where accepted baselines live.
 *
 * Overridable so the comparison logic can be exercised against a scratch
 * directory — driving a real browser through "first run", "small change",
 * "real change" and "resized" is slow and imprecise, and would write into the
 * committed baselines to do it.
 */
export const baselineDir = (): string =>
  process.env.OPENBOARD_UI_BASELINE_DIR ?? join(import.meta.dirname, '..', '__baseline__');

/** Fraction of pixels allowed to differ before it counts as drift. */
const MAX_DIFF_RATIO = 0.002;

/** Per-pixel colour tolerance; antialiasing differs slightly between runs. */
const PIXEL_THRESHOLD = 0.12;

export interface BaselineResult {
  status: 'seeded' | 'match' | 'drift' | 'resized';
  finding?: Finding;
  diffPath?: string;
}

/**
 * Compare and, when asked, accept.
 *
 * `OPENBOARD_UI_UPDATE_BASELINE=1` rewrites baselines instead of comparing —
 * the deliberate act of accepting a new look, which should never be something
 * an ordinary run can do by accident.
 */
export function compareToBaseline(screen: string, name: string, actual: Buffer): BaselineResult {
  const baselinePath = join(baselineDir(), `${name}.png`);
  const updating = process.env.OPENBOARD_UI_UPDATE_BASELINE === '1';

  if (updating || !existsSync(baselinePath)) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, actual);
    return { status: 'seeded' };
  }

  const expected = PNG.sync.read(readFileSync(baselinePath));
  const current = PNG.sync.read(actual);

  if (expected.width !== current.width || expected.height !== current.height) {
    // Size changes are reported rather than diffed: pixelmatch cannot compare
    // mismatched dimensions, and a page that grew or shrank is itself the news.
    return {
      status: 'resized',
      finding: {
        screen,
        severity: 'error',
        rule: 'baseline-size',
        detail: `Page size changed from ${expected.width}x${expected.height} to ${current.width}x${current.height}.`,
      },
    };
  }

  const diff = new PNG({ width: expected.width, height: expected.height });
  const changed = pixelmatch(
    expected.data,
    current.data,
    diff.data,
    expected.width,
    expected.height,
    { threshold: PIXEL_THRESHOLD },
  );

  const total = expected.width * expected.height;
  const ratio = changed / total;
  if (ratio <= MAX_DIFF_RATIO) return { status: 'match' };

  const diffPath = join(baselineDir(), '..', '__screens__', `${name}.diff.png`);
  mkdirSync(dirname(diffPath), { recursive: true });
  writeFileSync(diffPath, PNG.sync.write(diff));

  return {
    status: 'drift',
    diffPath,
    finding: {
      screen,
      severity: 'error',
      rule: 'baseline-drift',
      detail:
        `${changed} pixels changed (${(ratio * 100).toFixed(2)}%, budget ${(MAX_DIFF_RATIO * 100).toFixed(2)}%). ` +
        `Diff: ${diffPath}. Accept with OPENBOARD_UI_UPDATE_BASELINE=1.`,
    },
  };
}
