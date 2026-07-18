import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataParserService } from '../../src/services/data/DataParserService.js';

describe('DataParserService performance smoke test', () => {
  let dir: string;
  let path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openboard-parser-perf-'));
    path = join(dir, 'large.csv');
    const rows = ['id,amount,active'];
    for (let index = 0; index < 50_000; index++) rows.push(`${index},${index / 100},${index % 2 === 0}`);
    writeFileSync(path, rows.join('\n'), 'utf-8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('streams and casts 50,000 rows within a broad regression budget', async () => {
    const started = performance.now();
    const parsed = await DataParserService.parse(path);
    const elapsed = performance.now() - started;
    expect(parsed.rows).toHaveLength(50_000);
    expect(parsed.rows[49_999]).toMatchObject({ id: 49_999, active: false });
    // Intentionally broad: catches accidental quadratic work without flaking on CI.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);
});

