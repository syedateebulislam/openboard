import type { ParsedData } from './DataParserService.js';

export type ColumnType = 'number' | 'date' | 'string' | 'boolean' | 'mixed';

export interface ColumnStats {
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
}

export interface ColumnAnalysis {
  name: string;
  type: ColumnType;
  isCategorical?: boolean;
  uniqueValues?: string[];
  stats?: ColumnStats;
  nullCount: number;
  dateRange?: { earliest: string; latest: string };
  dateFormat?: string;
}

export interface DataAnalysis {
  rowCount: number;
  columnCount: number;
  columns: ColumnAnalysis[];
  sampleRows: Record<string, unknown>[];
}

const DATE_PATTERNS = [
  { regex: /^\d{4}-\d{2}-\d{2}$/, format: 'YYYY-MM-DD' },
  { regex: /^\d{2}\/\d{2}\/\d{4}$/, format: 'MM/DD/YYYY' },
  { regex: /^\d{2}-\d{2}-\d{4}$/, format: 'DD-MM-YYYY' },
];

export class DataAnalyzer {
  static analyze(parsed: ParsedData): DataAnalysis {
    const { rows, headers } = parsed;
    const columns: ColumnAnalysis[] = headers.map(name => DataAnalyzer.analyzeColumn(name, rows));

    return {
      rowCount: rows.length,
      columnCount: headers.length,
      columns,
      sampleRows: rows.slice(0, 5),
    };
  }

  private static analyzeColumn(name: string, rows: Record<string, unknown>[]): ColumnAnalysis {
    const values = rows.map(r => r[name]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    const nullCount = values.length - nonNull.length;

    // Determine type
    const type = DataAnalyzer.inferType(nonNull);
    const analysis: ColumnAnalysis = { name, type, nullCount };

    if (type === 'number') {
      const nums = nonNull as number[];
      nums.sort((a, b) => a - b);
      analysis.stats = {
        min: Math.min(...nums),
        max: Math.max(...nums),
        mean: nums.reduce((a, b) => a + b, 0) / nums.length,
        median:
          nums.length % 2 === 0
            ? (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2
            : nums[Math.floor(nums.length / 2)],
      };
    }

    if (type === 'date') {
      const dates = (nonNull as string[]).sort();
      const fmt = DATE_PATTERNS.find(p => p.regex.test(dates[0]));
      analysis.dateRange = { earliest: dates[0], latest: dates[dates.length - 1] };
      analysis.dateFormat = fmt?.format;
    }

    if (type === 'string') {
      const unique = [...new Set(nonNull as string[])];
      if (unique.length <= 20 && unique.length < nonNull.length * 0.5) {
        analysis.isCategorical = true;
        analysis.uniqueValues = unique;
      }
    }

    return analysis;
  }

  private static inferType(values: unknown[]): ColumnType {
    if (values.length === 0) return 'string';

    const types = new Set(
      values.map(v => {
        if (typeof v === 'boolean') return 'boolean';
        if (typeof v === 'number') return 'number';
        if (typeof v === 'string') {
          if (DATE_PATTERNS.some(p => p.regex.test(v))) return 'date';
          return 'string';
        }
        return 'mixed';
      }),
    );

    if (types.size === 1) return [...types][0] as ColumnType;
    if (types.has('mixed')) return 'mixed';
    if (types.size === 2 && types.has('number') && types.has('string')) return 'mixed';
    return 'string';
  }

  static generateSummary(analysis: DataAnalysis): string {
    const lines: string[] = [
      `Dataset: ${analysis.rowCount} rows, ${analysis.columnCount} columns`,
      '',
      'Columns:',
    ];

    for (const col of analysis.columns) {
      let line = `  - ${col.name} (${col.type})`;
      if (col.stats) {
        line += ` | min: ${col.stats.min?.toFixed(2)}, max: ${col.stats.max?.toFixed(2)}, mean: ${col.stats.mean?.toFixed(2)}`;
      }
      if (col.dateRange) {
        line += ` | range: ${col.dateRange.earliest} to ${col.dateRange.latest}`;
      }
      if (col.isCategorical && col.uniqueValues) {
        line += ` | values: [${col.uniqueValues.slice(0, 5).join(', ')}${col.uniqueValues.length > 5 ? '...' : ''}]`;
      }
      if (col.nullCount > 0) line += ` | nulls: ${col.nullCount}`;
      lines.push(line);
    }

    lines.push('', 'Sample rows (first 3):');
    for (const row of analysis.sampleRows.slice(0, 3)) {
      lines.push('  ' + JSON.stringify(row));
    }

    const summary = lines.join('\n');
    // Cap at ~8000 chars to stay within token limits
    return summary.length > 8000 ? summary.slice(0, 8000) + '\n...(truncated)' : summary;
  }
}
