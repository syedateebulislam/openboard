/**
 * Batch failures share a cause far more often than not — one project lock, one
 * missing workspace. Reporting each result verbatim repeated a single sentence
 * once per dashboard, which filled the whole log pane and pushed the lines that
 * explained what happened out of view.
 */

import { describe, it, expect } from 'vitest';
import { summariseFailures } from '../../src/utils/summariseFailures.js';

describe('summariseFailures', () => {
  it('collapses one shared cause into a single counted entry', () => {
    const locked = 'Project is locked by another OpenBoardCLI run (pid 2700, since 2026-08-03T19:08:07.690Z).';
    const line = summariseFailures(Array(9).fill(locked));
    expect(line).toBe(`${locked} (×9)`);
    // The observed report was this sentence nine times over.
    expect(line.match(/Project is locked/g)).toHaveLength(1);
  });

  it('keeps genuinely different problems', () => {
    expect(summariseFailures(['disk full', 'no network'])).toBe('disk full; no network');
  });

  it('counts repeats but keeps first-seen order', () => {
    expect(summariseFailures(['a', 'b', 'a'])).toBe('a (×2); b');
  });

  it('does not annotate a lone failure with a count', () => {
    expect(summariseFailures(['just one'])).toBe('just one');
  });

  it('treats blank and missing errors as one reportable cause', () => {
    // A result that failed without a message is still a failure; silently
    // dropping it made the count disagree with the text beside it.
    expect(summariseFailures([undefined, '', '   '])).toBe('Unknown error (×3)');
  });

  it('ignores whitespace differences when deciding two causes match', () => {
    expect(summariseFailures(['locked ', ' locked'])).toBe('locked (×2)');
  });

  it('returns an empty string for no failures', () => {
    expect(summariseFailures([])).toBe('');
  });
});
