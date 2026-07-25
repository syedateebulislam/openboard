/**
 * Phase 10 — DataParserService regression coverage for CSV/JSON paths.
 *
 * These pin the non-Excel parsing behavior so the xlsx → exceljs migration
 * (security fix: GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9) cannot change it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataParserService } from '../../src/services/data/DataParserService.js';

describe('DataParserService CSV/JSON regression', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-parser-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  function writeFixture(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  describe('CSV', () => {
    it('parses headers and auto-casts numbers and booleans', async () => {
      const path = writeFixture('data.csv', 'name,amount,active\nZomato,450,true\nUber,220.5,false\n');

      const parsed = await DataParserService.parse(path);

      expect(parsed.format).toBe('csv');
      expect(parsed.headers).toEqual(['name', 'amount', 'active']);
      expect(parsed.rows).toEqual([
        { name: 'Zomato', amount: 450, active: true },
        { name: 'Uber', amount: 220.5, active: false },
      ]);
    });

    it('keeps non-numeric strings as strings and skips empty lines', async () => {
      const path = writeFixture('data.csv', 'id,label\n\n1,alpha beta\n2,42abc\n');

      const parsed = await DataParserService.parse(path);

      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].label).toBe('alpha beta');
      expect(parsed.rows[1].label).toBe('42abc');
    });

    it('returns empty rows and headers for an empty CSV', async () => {
      const path = writeFixture('empty.csv', '');

      const parsed = await DataParserService.parse(path);

      expect(parsed.rows).toEqual([]);
      expect(parsed.headers).toEqual([]);
    });

    it('reports a missing CSV file clearly', async () => {
      await expect(DataParserService.parse(join(dir, 'missing.csv')))
        .rejects.toThrow(/File not found/);
    });

    it('accepts a path wrapped in quotes (Windows "Copy as path")', async () => {
      const path = writeFixture('quoted.csv', 'name,amount\nZomato,450\n');

      const parsed = await DataParserService.parse(`"${path}"`);

      expect(parsed.format).toBe('csv');
      expect(parsed.rows).toEqual([{ name: 'Zomato', amount: 450 }]);
    });

    it('reports stream metrics and enforces the materialized row limit', async () => {
      const path = writeFixture('limited.csv', 'id\n1\n2\n3\n');
      const parsed = await DataParserService.parse(path);
      expect(parsed.sourceBytes).toBeGreaterThan(0);
      expect(parsed.parseDurationMs).toBeGreaterThanOrEqual(0);
      await expect(DataParserService.parse(path, { maxRows: 2 })).rejects.toThrow(/Row limit exceeded/);
    });
  });

  describe('JSON', () => {
    it('parses a top-level array of objects', async () => {
      const path = writeFixture('rows.json', JSON.stringify([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]));

      const parsed = await DataParserService.parse(path);

      expect(parsed.format).toBe('json');
      expect(parsed.headers).toEqual(['a', 'b']);
      expect(parsed.rows).toHaveLength(2);
    });

    it('finds the first array property of a wrapper object', async () => {
      const path = writeFixture('wrapped.json', JSON.stringify({ meta: 'x', records: [{ id: 1 }, { id: 2 }] }));

      const parsed = await DataParserService.parse(path);

      expect(parsed.rows).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('wraps a plain object without array properties as a single row', async () => {
      const path = writeFixture('single.json', JSON.stringify({ id: 7, name: 'solo' }));

      const parsed = await DataParserService.parse(path);

      expect(parsed.rows).toEqual([{ id: 7, name: 'solo' }]);
    });

    it('throws a JSON parse error for malformed input', async () => {
      const path = writeFixture('broken.json', '{ not json');

      await expect(DataParserService.parse(path)).rejects.toThrow(/JSON parse error/);
    });
  });

  it('rejects unsupported extensions with the supported-format list', async () => {
    await expect(DataParserService.parse(join(dir, 'data.parquet')))
      .rejects.toThrow(/Unsupported format/);
  });
});
