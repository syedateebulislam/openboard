/**
 * Phase 9 — Excel (.xlsx/.xls) data-source support in DataParserService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import { DataParserService } from '../../src/services/data/DataParserService.js';

describe('DataParserService Excel support', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-xlsx-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  function writeWorkbook(fileName: string, rows: Record<string, unknown>[]): string {
    const path = join(dir, fileName);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
    XLSX.writeFile(wb, path);
    return path;
  }

  it('parses the first sheet of an .xlsx file into rows + headers', async () => {
    const path = writeWorkbook('orders.xlsx', [
      { date: '2026-07-01', merchant: 'Zomato', amount: 450 },
      { date: '2026-07-02', merchant: 'Uber', amount: 220 },
    ]);

    const parsed = await DataParserService.parse(path);

    expect(parsed.format).toBe('xlsx');
    expect(parsed.headers).toEqual(['date', 'merchant', 'amount']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].merchant).toBe('Zomato');
    expect(parsed.rows[1].amount).toBe(220);
  });

  it('serializes Excel date cells to ISO strings (JSON-safe rows)', async () => {
    const path = writeWorkbook('dates.xlsx', [
      { when: new Date('2026-07-10T00:00:00Z'), amount: 100 },
    ]);

    const parsed = await DataParserService.parse(path);

    expect(typeof parsed.rows[0].when).toBe('string');
    expect(String(parsed.rows[0].when)).toContain('2026-07');
    expect(() => JSON.stringify(parsed.rows)).not.toThrow();
  });

  it('lists xlsx among supported formats in the unsupported-extension error', async () => {
    await expect(DataParserService.parse(join(dir, 'data.txt')))
      .rejects.toThrow(/Supported: \.csv, \.xlsx, \.xls, \.json/);
  });

  it('reports a missing Excel file clearly', async () => {
    await expect(DataParserService.parse(join(dir, 'missing.xlsx')))
      .rejects.toThrow(/File not found/);
  });
});
