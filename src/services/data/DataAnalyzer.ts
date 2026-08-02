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

/**
 * Comparable value for a date string, honouring the format it is written in.
 *
 * Only YYYY-MM-DD sorts correctly as text. The other two supported formats put
 * the day or month first, so a plain `.sort()` ordered 12/01/2025 before
 * 06/15/2025 and reported the range inverted. That range is fed to the model in
 * the data summary, so the dashboards it writes inherit the wrong time span —
 * a plausible-looking wrong answer rather than a visible failure.
 *
 * Returns NaN for anything unrecognised so callers can keep those out of the
 * comparison instead of letting them decide the boundaries.
 */
function dateSortKey(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T00:00:00Z`);
  }
  const slashed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value); // MM/DD/YYYY
  if (slashed) {
    return Date.UTC(Number(slashed[3]), Number(slashed[1]) - 1, Number(slashed[2]));
  }
  const dashed = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value); // DD-MM-YYYY
  if (dashed) {
    return Date.UTC(Number(dashed[3]), Number(dashed[2]) - 1, Number(dashed[1]));
  }
  return Number.NaN;
}

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
        // Read the ends of the sorted array rather than spreading it into
        // Math.min/Math.max. Spreading passes one argument per element, which
        // exceeds the call-stack limit somewhere around 125k values — well
        // inside the 1,000,000-row ceiling the parser accepts — and took down
        // the whole analysis with a RangeError. The array is already sorted,
        // so the ends are exact and free.
        min: nums[0],
        max: nums[nums.length - 1],
        mean: nums.reduce((a, b) => a + b, 0) / nums.length,
        median:
          nums.length % 2 === 0
            ? (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2
            : nums[Math.floor(nums.length / 2)],
      };
    }

    if (type === 'date') {
      const raw = nonNull as string[];
      // Detect the format from any recognised value, not from whichever one
      // happened to sort first — the old code read dates[0] after a sort that
      // was itself wrong for two of the three formats.
      const fmt = DATE_PATTERNS.find(p => raw.some(value => p.regex.test(value)));

      const comparable = raw
        .map(value => ({ value, key: dateSortKey(value) }))
        .filter(entry => !Number.isNaN(entry.key))
        .sort((a, b) => a.key - b.key);

      if (comparable.length > 0) {
        analysis.dateRange = {
          earliest: comparable[0].value,
          latest: comparable[comparable.length - 1].value,
        };
      } else {
        // Nothing parsed: fall back to text order rather than report no range
        // at all, which is what a column of unrecognised formats used to get.
        const lexical = [...raw].sort();
        analysis.dateRange = { earliest: lexical[0], latest: lexical[lexical.length - 1] };
      }
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

    const sampleCount = Math.min(3, analysis.sampleRows.length);
    lines.push('', `Sample rows (showing ${sampleCount} of ${analysis.rowCount} total; the deployed dashboard loads the full dataset):`);
    for (const row of analysis.sampleRows.slice(0, 3)) {
      lines.push('  ' + JSON.stringify(row));
    }

    const mixedColumns = analysis.columns.filter((col) => col.type === 'mixed').map((col) => col.name);
    if (mixedColumns.length > 0) {
      lines.push('', `Type-inference warning: column(s) with mixed/ambiguous types: ${mixedColumns.join(', ')}. Handle both numeric and string values defensively.`);
    }

    const summary = lines.join('\n');
    // Cap at ~8000 chars to stay within token limits
    return summary.length > 8000 ? summary.slice(0, 8000) + '\n...(truncated)' : summary;
  }
}
