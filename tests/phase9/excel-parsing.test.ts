/**
 * Phase 9 — Excel (.xlsx) data-source support in DataParserService.
 *
 * Parsing is backed by ExcelJS (SheetJS `xlsx` was dropped for unfixed
 * prototype-pollution/ReDoS advisories). Legacy .xls is no longer supported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { DataParserService } from '../../src/services/data/DataParserService.js';

describe('DataParserService Excel support', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-xlsx-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  async function writeWorkbook(fileName: string, rows: Record<string, unknown>[]): Promise<string> {
    const path = join(dir, fileName);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      sheet.addRow(headers);
      for (const row of rows) {
        sheet.addRow(headers.map(h => row[h]));
      }
    }
    await wb.xlsx.writeFile(path);
    return path;
  }

  it('parses the first sheet of an .xlsx file into rows + headers', async () => {
    const path = await writeWorkbook('orders.xlsx', [
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
    const path = await writeWorkbook('dates.xlsx', [
      { when: new Date('2026-07-10T00:00:00Z'), amount: 100 },
    ]);

    const parsed = await DataParserService.parse(path);

    expect(typeof parsed.rows[0].when).toBe('string');
    expect(String(parsed.rows[0].when)).toContain('2026-07');
    expect(() => JSON.stringify(parsed.rows)).not.toThrow();
  });

  it('fills missing cells with empty strings', async () => {
    const path = join(dir, 'sparse.xlsx');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    sheet.addRow(['a', 'b', 'c']);
    sheet.addRow([1, 2, 3]);
    sheet.addRow([4, undefined, 6]);
    await wb.xlsx.writeFile(path);

    const parsed = await DataParserService.parse(path);

    expect(parsed.rows).toEqual([
      { a: 1, b: 2, c: 3 },
      { a: 4, b: '', c: 6 },
    ]);
  });

  it('parses an empty workbook sheet into empty rows and headers', async () => {
    const path = await writeWorkbook('empty.xlsx', []);

    const parsed = await DataParserService.parse(path);

    expect(parsed.rows).toEqual([]);
    expect(parsed.headers).toEqual([]);
  });

  it('rejects legacy .xls files with a clear re-save message', async () => {
    await expect(DataParserService.parse(join(dir, 'old.xls')))
      .rejects.toThrow(/\.xls workbooks are not supported.*\.xlsx/);
  });

  it('lists xlsx among supported formats in the unsupported-extension error', async () => {
    await expect(DataParserService.parse(join(dir, 'data.txt')))
      .rejects.toThrow(/Supported: \.csv, \.xlsx, \.json/);
  });

  it('reports a missing Excel file clearly', async () => {
    await expect(DataParserService.parse(join(dir, 'missing.xlsx')))
      .rejects.toThrow(/File not found/);
  });
});
