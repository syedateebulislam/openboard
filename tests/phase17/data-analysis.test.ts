/**
 * Phase 17 — column analysis correctness.
 *
 * Both bugs here fed the model rather than the screen: dateRange and stats go
 * into the data summary that the generation prompt carries, so a wrong value
 * became a dashboard built on a wrong premise. One of them crashed outright,
 * the other returned a plausible lie.
 */

import { describe, it, expect } from 'vitest';
import { DataAnalyzer } from '../../src/services/data/DataAnalyzer.js';
import type { ParsedData } from '../../src/services/data/DataParserService.js';

const parsed = (rows: Record<string, unknown>[], headers: string[]): ParsedData =>
  ({ rows, headers, format: 'csv' }) as ParsedData;

const column = (rows: Record<string, unknown>[], name: string) =>
  DataAnalyzer.analyze(parsed(rows, [name])).columns[0];

describe('numeric statistics', () => {
  it('survives a column far larger than the argument limit', () => {
    // Math.min(...nums) passes one argument per element and threw RangeError
    // somewhere near 125k — inside the 1,000,000-row ceiling the parser
    // accepts, so a legitimate file took down the whole analysis.
    const rows = Array.from({ length: 300_000 }, (_, i) => ({ amount: i }));
    const stats = column(rows, 'amount').stats!;
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(299_999);
  });

  it('still reports the right ends for a small column', () => {
    const rows = [{ n: 5 }, { n: -2 }, { n: 11 }, { n: 0 }];
    const stats = column(rows, 'n').stats!;
    expect(stats.min).toBe(-2);
    expect(stats.max).toBe(11);
  });

  it('handles negatives and decimals', () => {
    const rows = [{ n: -10.5 }, { n: 3.25 }, { n: -0.75 }];
    const stats = column(rows, 'n').stats!;
    expect(stats.min).toBe(-10.5);
    expect(stats.max).toBe(3.25);
  });

  it('keeps mean and median intact', () => {
    const stats = column([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 'n').stats!;
    expect(stats.mean).toBe(2.5);
    expect(stats.median).toBe(2.5);
  });
});

describe('date ranges', () => {
  const range = (values: string[]) => column(values.map((d) => ({ d })), 'd');

  it('orders MM/DD/YYYY by real date, not by text', () => {
    // Text order put 01/02/2026 first and 12/01/2025 last — the range inverted.
    const analysis = range(['12/01/2025', '01/02/2026', '06/15/2025']);
    expect(analysis.dateFormat).toBe('MM/DD/YYYY');
    expect(analysis.dateRange).toEqual({ earliest: '06/15/2025', latest: '01/02/2026' });
  });

  it('orders DD-MM-YYYY by real date', () => {
    const analysis = range(['01-12-2025', '02-01-2026', '15-06-2025']);
    expect(analysis.dateFormat).toBe('DD-MM-YYYY');
    expect(analysis.dateRange).toEqual({ earliest: '15-06-2025', latest: '02-01-2026' });
  });

  it('still handles ISO, where text order was already correct', () => {
    const analysis = range(['2025-12-01', '2026-01-02', '2025-06-15']);
    expect(analysis.dateFormat).toBe('YYYY-MM-DD');
    expect(analysis.dateRange).toEqual({ earliest: '2025-06-15', latest: '2026-01-02' });
  });

  it('distinguishes day-first from month-first by separator', () => {
    // 01/02 is 2 January under MM/DD and 01-02 is 1 February under DD-MM;
    // reading the separator is the only thing telling them apart.
    expect(range(['01/02/2026', '01/03/2026']).dateRange!.latest).toBe('01/03/2026');
    expect(range(['01-02-2026', '01-03-2026']).dateRange!.latest).toBe('01-03-2026');
  });

  it('detects the format from any recognised value, not the first sorted one', () => {
    expect(range(['06/15/2025', '12/01/2025']).dateFormat).toBe('MM/DD/YYYY');
  });

  it('reports a single date as both ends', () => {
    expect(range(['06/15/2025']).dateRange).toEqual({ earliest: '06/15/2025', latest: '06/15/2025' });
  });

  it('never claims a range that runs backwards', () => {
    // The property that matters regardless of format.
    for (const values of [
      ['12/01/2025', '01/02/2026', '06/15/2025'],
      ['01-12-2025', '02-01-2026', '15-06-2025'],
      ['2025-12-01', '2026-01-02'],
    ]) {
      const { earliest, latest } = range(values).dateRange!;
      const toMs = (v: string) => {
        if (/^\d{4}-/.test(v)) return Date.parse(v);
        const [a, b, c] = v.split(/[/-]/).map(Number);
        return v.includes('/') ? Date.UTC(c, a - 1, b) : Date.UTC(c, b - 1, a);
      };
      expect(toMs(earliest)).toBeLessThanOrEqual(toMs(latest));
    }
  });
});
