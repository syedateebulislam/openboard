/**
 * Baseline diffing for the UI suite.
 *
 * Tested here rather than by running the browser twice: the interesting cases
 * are the boundaries — a first run with nothing to compare against, a change
 * too small to matter, a change that matters, and a page that changed size —
 * and driving a real browser into each of those is slow and imprecise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { compareToBaseline } from '../../tests/ui/harness/baseline.js';

/** A solid image, optionally with `dirty` pixels painted a different colour. */
function png(width: number, height: number, dirty = 0): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    const changed = index < dirty;
    image.data[offset] = changed ? 0 : 255;
    image.data[offset + 1] = changed ? 0 : 255;
    image.data[offset + 2] = changed ? 0 : 255;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

let dir: string;

beforeEach(() => {
  // The module reads the directory on every call, so a plain import is enough.
  dir = mkdtempSync(join(tmpdir(), 'openboard-baseline-'));
  process.env.OPENBOARD_UI_BASELINE_DIR = dir;
  delete process.env.OPENBOARD_UI_UPDATE_BASELINE;
});

afterEach(() => {
  delete process.env.OPENBOARD_UI_BASELINE_DIR;
  delete process.env.OPENBOARD_UI_UPDATE_BASELINE;
  rmSync(dir, { recursive: true, force: true });
});

describe('compareToBaseline', () => {
  it('seeds a missing baseline instead of failing the first run', () => {
    // A suite whose very first run is red teaches people to pass --update
    // reflexively, and after that nobody reads the diffs at all.
    const result = compareToBaseline('screen', 'a', png(20, 20));
    expect(result.status).toBe('seeded');
    expect(result.finding).toBeUndefined();
    expect(existsSync(join(dir, 'a.png'))).toBe(true);
  });

  it('reports a match when nothing changed', () => {
    compareToBaseline('screen', 'b', png(20, 20));
    expect(compareToBaseline('screen', 'b', png(20, 20)).status).toBe('match');
  });

  it('tolerates a change too small to be a regression', () => {
    compareToBaseline('screen', 'c', png(100, 100));
    // 4 pixels of 10,000 = 0.04%, under the 0.2% budget.
    expect(compareToBaseline('screen', 'c', png(100, 100, 4)).status).toBe('match');
  });

  it('reports drift, names the budget, and writes a diff image', () => {
    compareToBaseline('screen', 'd', png(100, 100));
    const result = compareToBaseline('screen', 'd', png(100, 100, 2000));

    expect(result.status).toBe('drift');
    expect(result.finding?.rule).toBe('baseline-drift');
    expect(result.finding?.detail).toMatch(/budget/);
    // The diff has to be findable from the report, not just counted.
    expect(result.diffPath && existsSync(result.diffPath)).toBe(true);
  });

  it('reports a size change rather than trying to diff it', () => {
    // pixelmatch cannot compare mismatched dimensions, and a page that grew or
    // shrank is itself the news.
    compareToBaseline('screen', 'e', png(100, 100));
    const result = compareToBaseline('screen', 'e', png(120, 100));

    expect(result.status).toBe('resized');
    expect(result.finding?.rule).toBe('baseline-size');
    expect(result.finding?.detail).toContain('100x100');
    expect(result.finding?.detail).toContain('120x100');
  });

  it('only accepts a new look when explicitly told to', () => {
    const original = png(100, 100);
    compareToBaseline('screen', 'f', original);
    expect(compareToBaseline('screen', 'f', png(100, 100, 5000)).status).toBe('drift');

    process.env.OPENBOARD_UI_UPDATE_BASELINE = '1';
    expect(compareToBaseline('screen', 'f', png(100, 100, 5000)).status).toBe('seeded');

    // And the accepted image is the new one, not the old.
    delete process.env.OPENBOARD_UI_UPDATE_BASELINE;
    expect(readFileSync(join(dir, 'f.png')).equals(original)).toBe(false);
    expect(compareToBaseline('screen', 'f', png(100, 100, 5000)).status).toBe('match');
  });
});
