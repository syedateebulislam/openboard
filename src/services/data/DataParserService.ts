import { parse as createCSVParser } from 'csv-parse';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

export interface ParsedData {
  rows: Record<string, unknown>[];
  headers: string[];
  format: 'csv' | 'json' | 'xlsx';
  sourceBytes?: number;
  parseDurationMs?: number;
}

export interface DataParserOptions {
  /** Safety bound for materialized output. CSV input itself is streamed. */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 1_000_000;

export class DataParserService {
  static async parse(filePath: string, options: DataParserOptions = {}): Promise<ParsedData> {
    const ext = extname(filePath).toLowerCase();

    if (ext === '.xls') {
      throw new Error('Legacy .xls workbooks are not supported. Re-save the file as .xlsx and retry.');
    }

    if (!['.csv', '.json', '.xlsx'].includes(ext)) {
      throw new Error(`Unsupported format "${ext}". Supported: .csv, .xlsx, .json`);
    }

    try {
      await access(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    const startedAt = performance.now();
    const sourceBytes = (await stat(filePath)).size;
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    let parsed: ParsedData;

    if (ext === '.csv') {
      parsed = await DataParserService.parseCSVStream(filePath, maxRows);
    } else if (ext === '.xlsx') {
      parsed = await DataParserService.parseExcel(filePath, maxRows);
    } else {
      parsed = DataParserService.parseJSON(await readFile(filePath, 'utf-8'), maxRows);
    }
    return { ...parsed, sourceBytes, parseDurationMs: performance.now() - startedAt };
  }

  /** Parse the first sheet of an .xlsx workbook into rows. */
  private static async parseExcel(filePath: string, maxRows: number): Promise<ParsedData> {
    // Lazy import — ExcelJS is only loaded when an Excel file is parsed.
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    // Feed ExcelJS a stream so OpenBoard does not retain a duplicate file buffer.
    await workbook.xlsx.read(createReadStream(filePath));
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('Excel file contains no sheets.');
    }

    const headers: string[] = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber - 1] = String(DataParserService.excelCellValue(cell.value) ?? '');
    });

    const rows: Record<string, unknown>[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (rows.length >= maxRows) {
        throw new Error(`Row limit exceeded (${maxRows.toLocaleString()}). Increase maxRows explicitly to continue.`);
      }
      const record: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        if (!header) return;
        const value = DataParserService.excelCellValue(row.getCell(index + 1).value);
        record[header] = value ?? '';
      });
      rows.push(record);
    });

    return { rows, headers: headers.filter(Boolean), format: 'xlsx' };
  }

  /**
   * Normalize an ExcelJS cell value to a JSON-serializable primitive.
   * Date cells become ISO strings so rows stay JSON-serializable for
   * api/_data and the LLM data summary.
   */
  private static excelCellValue(value: unknown): unknown {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const cell = value as Record<string, unknown>;
      // Formula cells carry their computed result.
      if ('result' in cell) return DataParserService.excelCellValue(cell.result);
      // Rich text cells: concatenate the runs.
      if (Array.isArray(cell.richText)) {
        return (cell.richText as { text?: string }[]).map(part => part.text ?? '').join('');
      }
      // Hyperlink cells expose display text.
      if ('text' in cell) return DataParserService.excelCellValue(cell.text);
      // Error cells ({ error: '#N/A' }) and anything else unknown → ''.
      return '';
    }
    return value;
  }

  private static async parseCSVStream(filePath: string, maxRows: number): Promise<ParsedData> {
    const parser = createReadStream(filePath).pipe(createCSVParser({
      columns: true,
      skip_empty_lines: true,
      cast: (value, context) => {
        if (context.header) return value;
        // Auto-convert numeric strings
        const num = Number(value);
        if (value.trim() !== '' && !isNaN(num)) return num;
        // Boolean
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
      },
      relax_column_count: true,
    }));

    const records: Record<string, unknown>[] = [];
    for await (const record of parser) {
      if (records.length >= maxRows) {
        parser.destroy();
        throw new Error(`Row limit exceeded (${maxRows.toLocaleString()}). Increase maxRows explicitly to continue.`);
      }
      records.push(record as Record<string, unknown>);
    }

    const headers = records.length > 0 ? Object.keys(records[0]) : [];
    return { rows: records, headers, format: 'csv' };
  }

  private static parseJSON(content: string, maxRows: number): ParsedData {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (e) {
      throw new Error(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    }

    let rows: Record<string, unknown>[];

    if (Array.isArray(data)) {
      rows = data as Record<string, unknown>[];
    } else if (data && typeof data === 'object') {
      // Find the first array property (flatten nested)
      const obj = data as Record<string, unknown>;
      const arrayKey = Object.keys(obj).find(k => Array.isArray(obj[k]));
      if (arrayKey) {
        rows = obj[arrayKey] as Record<string, unknown>[];
      } else {
        rows = [obj];
      }
    } else {
      rows = [];
    }

    if (rows.length > maxRows) {
      throw new Error(`Row limit exceeded (${maxRows.toLocaleString()}). Increase maxRows explicitly to continue.`);
    }

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, headers, format: 'json' };
  }
}
