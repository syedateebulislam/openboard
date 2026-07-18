import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataParserService } from '../src/services/data/DataParserService.js';

describe('streaming CSV parser benchmark', () => {
  let dir: string;
  let csvPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-parser-bench-'));
    csvPath = join(dir, '100k.csv');
    const rows = ['id,amount,active,label'];
    for (let index = 0; index < 100_000; index++) {
      rows.push(`${index},${index / 10},${index % 2 === 0},item-${index}`);
    }
    writeFileSync(csvPath, rows.join('\n'), 'utf-8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('records repeatable 100,000-row throughput', async () => {
    const samples: number[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const started = performance.now();
      const parsed = await DataParserService.parse(csvPath);
      samples.push(performance.now() - started);
      expect(parsed.rows).toHaveLength(100_000);
    }
    const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const rowsPerSecond = Math.round(100_000 / (meanMs / 1_000));
    console.info(`CSV parser benchmark: mean=${meanMs.toFixed(1)}ms throughput=${rowsPerSecond.toLocaleString()} rows/s samples=${samples.map((v) => v.toFixed(1)).join(',')}`);
    expect(meanMs).toBeLessThan(15_000);
  }, 60_000);
});

