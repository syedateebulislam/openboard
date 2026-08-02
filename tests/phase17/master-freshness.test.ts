/**
 * Phase 17 — freshness reported by the master tab.
 *
 * The combined `__all__` payload answered with `generatedAt: new Date()`, the
 * time of the request. The master tab therefore claimed the data had just been
 * generated on every page load, however old it really was, while each
 * individual tab reported its true timestamp. The one view meant to summarise
 * the workspace was the only one lying about it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newestGeneratedAt } from '../../templates/dashboard/api/_freshness.js';

const TEMPLATE = join(process.cwd(), 'templates', 'dashboard');

describe('newestGeneratedAt', () => {
  it('reports the newest timestamp in the payload', () => {
    const newest = newestGeneratedAt({
      zomato: { generatedAt: '2026-08-01T19:43:02.150Z', rows: [] },
      airtel: { generatedAt: '2026-08-01T20:59:01.187Z', rows: [] },
      mmt: { generatedAt: '2026-08-01T21:04:27.862Z', rows: [] },
    });
    expect(newest).toBe('2026-08-01T21:04:27.862Z');
  });

  it('is not affected by key order', () => {
    const newest = newestGeneratedAt({
      mmt: { generatedAt: '2026-08-01T21:04:27.862Z' },
      zomato: { generatedAt: '2026-08-01T19:43:02.150Z' },
    });
    expect(newest).toBe('2026-08-01T21:04:27.862Z');
  });

  it('returns undefined rather than inventing a time when none is present', () => {
    // Omitting the field lets the header degrade gracefully. Substituting the
    // current time is the exact bug this replaces.
    expect(newestGeneratedAt({ a: { rows: [] }, b: { rows: [] } })).toBeUndefined();
    expect(newestGeneratedAt({})).toBeUndefined();
  });

  it('ignores entries that are not objects or carry no usable timestamp', () => {
    const newest = newestGeneratedAt({
      good: { generatedAt: '2026-08-01T10:00:00.000Z' },
      nullish: null,
      primitive: 42,
      blank: { generatedAt: '' },
      wrongType: { generatedAt: 12345 },
    } as unknown as Record<string, unknown>);
    expect(newest).toBe('2026-08-01T10:00:00.000Z');
  });

  it('prefers a parseable timestamp over an unparseable one', () => {
    const newest = newestGeneratedAt({
      broken: { generatedAt: 'not a date' },
      real: { generatedAt: '2026-08-01T10:00:00.000Z' },
    });
    expect(newest).toBe('2026-08-01T10:00:00.000Z');
  });

  it('never returns a moment later than the data it summarises', () => {
    // The property that actually matters: the header must not claim freshness
    // the payload cannot support.
    const stamps = ['2026-01-01T00:00:00.000Z', '2026-06-15T12:00:00.000Z'];
    const newest = newestGeneratedAt({
      a: { generatedAt: stamps[0] },
      b: { generatedAt: stamps[1] },
    })!;
    expect(Date.parse(newest)).toBeLessThanOrEqual(Math.max(...stamps.map((s) => Date.parse(s))));
    expect(Date.parse(newest)).toBeLessThan(Date.now());
  });
});

describe('both API handlers', () => {
  const vercel = readFileSync(join(TEMPLATE, 'api', 'dashboard-data.ts'), 'utf-8');
  const local = readFileSync(join(TEMPLATE, 'vite.local-api.ts'), 'utf-8');

  it('derive the combined timestamp instead of stamping the request', () => {
    for (const [name, source] of [['vercel', vercel], ['local preview', local]] as const) {
      expect(source, name).toContain('newestGeneratedAt');
      // The deployed and preview handlers must agree, or the same dashboard
      // reports different freshness depending on where it is being viewed.
      expect(source, name).not.toMatch(/generatedAt:\s*new Date\(\)\.toISOString\(\)/);
    }
  });
});

describe('shell sync', () => {
  it('ships _freshness.ts to existing projects alongside its importer', () => {
    // dashboard-data.ts is re-synced into every project before deploy. Adding
    // an import without adding the file to the same list would push a handler
    // that cannot resolve it — a build failure in the user's project, not ours.
    const templateService = readFileSync(
      join(process.cwd(), 'src', 'services', 'template', 'TemplateService.ts'),
      'utf-8',
    );
    const syncBlock = /const SHELL_SYNC_FILES = \[([\s\S]*?)\];/.exec(templateService)![1];
    expect(syncBlock).toContain("'api/dashboard-data.ts'");
    expect(syncBlock).toContain("'api/_freshness.ts'");
    expect(syncBlock).toContain("'vite.local-api.ts'");
  });
});
