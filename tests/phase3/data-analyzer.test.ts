/**
 * PHASE 3: DataAnalyzer Tests
 *
 * Tests pure functions: analyze(), generateSummary(), inferType(), analyzeColumn().
 * No mocking needed — all logic is pure data transformation.
 */

import { describe, it, expect } from 'vitest';
import { DataAnalyzer } from '../../src/services/data/DataAnalyzer.js';
import type { ParsedData } from '../../src/services/data/DataParserService.js';

function makeParsed(headers: string[], rows: Record<string, unknown>[]): ParsedData {
  return { headers, rows, rawText: '' };
}

describe('DataAnalyzer', () => {
  // -------------------------------------------------------------------------
  // analyze()
  // -------------------------------------------------------------------------

  describe('analyze', () => {
    it('should return correct rowCount and columnCount', () => {
      const data = makeParsed(['name', 'age'], [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);
      const result = DataAnalyzer.analyze(data);
      expect(result.rowCount).toBe(2);
      expect(result.columnCount).toBe(2);
    });

    it('should return column analysis for each header', () => {
      const data = makeParsed(['x', 'y'], [{ x: 1, y: 'a' }]);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0].name).toBe('x');
      expect(result.columns[1].name).toBe('y');
    });

    it('should return up to 5 sample rows', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const data = makeParsed(['id'], rows);
      const result = DataAnalyzer.analyze(data);
      expect(result.sampleRows).toHaveLength(5);
    });

    it('should handle empty dataset', () => {
      const data = makeParsed(['col1'], []);
      const result = DataAnalyzer.analyze(data);
      expect(result.rowCount).toBe(0);
      expect(result.columns[0].nullCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Number column analysis
  // -------------------------------------------------------------------------

  describe('Number Column Analysis', () => {
    it('should compute min, max, mean, median for numeric columns', () => {
      const data = makeParsed(['value'], [
        { value: 10 },
        { value: 20 },
        { value: 30 },
        { value: 40 },
      ]);
      const result = DataAnalyzer.analyze(data);
      const col = result.columns[0];
      expect(col.type).toBe('number');
      expect(col.stats).toBeDefined();
      expect(col.stats!.min).toBe(10);
      expect(col.stats!.max).toBe(40);
      expect(col.stats!.mean).toBe(25);
      expect(col.stats!.median).toBe(25); // even count: (20+30)/2
    });

    it('should compute correct median for odd count', () => {
      const data = makeParsed(['v'], [{ v: 1 }, { v: 3 }, { v: 5 }]);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns[0].stats!.median).toBe(3);
    });

    it('should count null values', () => {
      const data = makeParsed(['v'], [{ v: 1 }, { v: null }, { v: '' }, { v: 4 }]);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns[0].nullCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Date column analysis
  // -------------------------------------------------------------------------

  describe('Date Column Analysis', () => {
    it('should detect YYYY-MM-DD date format', () => {
      const data = makeParsed(['date'], [
        { date: '2024-01-15' },
        { date: '2024-06-30' },
        { date: '2024-12-01' },
      ]);
      const result = DataAnalyzer.analyze(data);
      const col = result.columns[0];
      expect(col.type).toBe('date');
      expect(col.dateFormat).toBe('YYYY-MM-DD');
      expect(col.dateRange).toBeDefined();
      expect(col.dateRange!.earliest).toBe('2024-01-15');
      expect(col.dateRange!.latest).toBe('2024-12-01');
    });

    it('should detect MM/DD/YYYY date format', () => {
      const data = makeParsed(['d'], [{ d: '01/15/2024' }, { d: '12/31/2024' }]);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns[0].type).toBe('date');
      expect(result.columns[0].dateFormat).toBe('MM/DD/YYYY');
    });
  });

  // -------------------------------------------------------------------------
  // String / Categorical analysis
  // -------------------------------------------------------------------------

  describe('String Column Analysis', () => {
    it('should detect categorical string columns', () => {
      const rows = [
        { status: 'active' },
        { status: 'inactive' },
        { status: 'active' },
        { status: 'pending' },
        { status: 'active' },
        { status: 'inactive' },
        { status: 'active' },
      ];
      const data = makeParsed(['status'], rows);
      const result = DataAnalyzer.analyze(data);
      const col = result.columns[0];
      expect(col.type).toBe('string');
      expect(col.isCategorical).toBe(true);
      expect(col.uniqueValues).toContain('active');
      expect(col.uniqueValues).toContain('inactive');
      expect(col.uniqueValues).toContain('pending');
    });

    it('should not mark high-cardinality strings as categorical', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ name: `unique-name-${i}` }));
      const data = makeParsed(['name'], rows);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns[0].isCategorical).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // Mixed type handling
  // -------------------------------------------------------------------------

  describe('Mixed Type Detection', () => {
    it('should detect mixed type when column has numbers and strings', () => {
      const data = makeParsed(['val'], [{ val: 42 }, { val: 'hello' }, { val: 10 }]);
      const result = DataAnalyzer.analyze(data);
      expect(result.columns[0].type).toBe('mixed');
    });

    it('should return string type for empty values array', () => {
      const data = makeParsed(['empty'], [{ empty: null }, { empty: '' }]);
      const result = DataAnalyzer.analyze(data);
      // All values are null/empty, so non-null array is empty → defaults to 'string'
      expect(result.columns[0].type).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // generateSummary()
  // -------------------------------------------------------------------------

  describe('generateSummary', () => {
    it('should include row and column counts', () => {
      const analysis = DataAnalyzer.analyze(
        makeParsed(['a', 'b'], [{ a: 1, b: 2 }, { a: 3, b: 4 }]),
      );
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary).toContain('2 rows');
      expect(summary).toContain('2 columns');
    });

    it('should include column names and types', () => {
      const analysis = DataAnalyzer.analyze(
        makeParsed(['price', 'label'], [{ price: 9.99, label: 'A' }]),
      );
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary).toContain('price (number)');
      expect(summary).toContain('label (string)');
    });

    it('should include stats for numeric columns', () => {
      const analysis = DataAnalyzer.analyze(
        makeParsed(['score'], [{ score: 10 }, { score: 20 }]),
      );
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary).toContain('min:');
      expect(summary).toContain('max:');
      expect(summary).toContain('mean:');
    });

    it('should include date range for date columns', () => {
      const analysis = DataAnalyzer.analyze(
        makeParsed(['date'], [{ date: '2024-01-01' }, { date: '2024-12-31' }]),
      );
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary).toContain('range:');
      expect(summary).toContain('2024-01-01');
    });

    it('should include sample rows', () => {
      const analysis = DataAnalyzer.analyze(
        makeParsed(['x'], [{ x: 42 }]),
      );
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary).toContain('Sample rows');
      expect(summary).toContain('42');
    });

    it('should truncate very long summaries', () => {
      // Create a dataset that generates a long summary
      const headers = Array.from({ length: 50 }, (_, i) => `col_${i}`);
      const row: Record<string, unknown> = {};
      for (const h of headers) row[h] = 'x'.repeat(100);
      const rows = Array.from({ length: 100 }, () => ({ ...row }));
      const analysis = DataAnalyzer.analyze(makeParsed(headers, rows));
      const summary = DataAnalyzer.generateSummary(analysis);
      expect(summary.length).toBeLessThanOrEqual(8100); // 8000 + truncation message
    });
  });
});
