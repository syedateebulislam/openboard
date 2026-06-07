import { parse } from 'csv-parse/sync';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface ParsedData {
  rows: Record<string, unknown>[];
  headers: string[];
  format: 'csv' | 'json';
}

export class DataParserService {
  static async parse(filePath: string): Promise<ParsedData> {
    const ext = extname(filePath).toLowerCase();

    if (ext !== '.csv' && ext !== '.json') {
      throw new Error(`Unsupported format "${ext}". Supported: .csv, .json`);
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (ext === '.csv') {
      return DataParserService.parseCSV(content);
    } else {
      return DataParserService.parseJSON(content);
    }
  }

  private static parseCSV(content: string): ParsedData {
    const records = parse(content, {
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
    }) as Record<string, unknown>[];

    const headers = records.length > 0 ? Object.keys(records[0]) : [];
    return { rows: records, headers, format: 'csv' };
  }

  private static parseJSON(content: string): ParsedData {
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

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, headers, format: 'json' };
  }
}
