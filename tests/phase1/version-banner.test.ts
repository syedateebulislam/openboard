/**
 * PHASE 1: Version Banner Sync
 *
 * Guards against a recurring release mistake: bumping package.json "version"
 * but shipping a stale vX.Y.Z banner in the CLI (`openboard --version` and the
 * TUI welcome screen).
 *
 * The banner version now comes from a single source of truth (src/version.ts,
 * which reads package.json), so this test:
 *   1. verifies that single source renders the current package version, and
 *   2. fails if anyone re-introduces a hardcoded vX.Y.Z literal into a banner
 *      source file or the documented banner — the exact regression that let a
 *      stale version ship before.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, bannerVersionLine, BANNER_INNER_WIDTH } from '../../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };

// Banner source files MUST NOT hardcode a version — they must derive it from
// src/version.ts. Any literal vX.Y.Z here is a regression.
const CODE_BANNER_FILES = ['src/index.tsx', 'src/screens/WelcomeScreen.tsx'];

// The documented banner ships in the npm package; keep its literal in sync.
const DOC_BANNER_FILES = ['user-manual.md'];

function literalVersions(relPath: string): string[] {
  const content = readFileSync(join(ROOT, relPath), 'utf-8');
  return [...content.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
}

describe('version banner sync', () => {
  it('package.json has a valid semver version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('src/version.ts VERSION equals package.json version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('bannerVersionLine renders the current version, centered to the box width', () => {
    const line = bannerVersionLine();
    expect(line).toContain(`v${pkg.version}`);
    expect(line.length).toBe(BANNER_INNER_WIDTH);
    expect(line.trim()).toBe(`v${pkg.version}`);
  });

  for (const relPath of CODE_BANNER_FILES) {
    it(`${relPath} does not hardcode a version literal`, () => {
      expect(literalVersions(relPath)).toEqual([]);
    });
  }

  for (const relPath of DOC_BANNER_FILES) {
    it(`${relPath} banner version matches package.json (${pkg.version})`, () => {
      const found = literalVersions(relPath);
      expect(found.length).toBeGreaterThan(0);
      for (const version of found) {
        expect(version).toBe(pkg.version);
      }
    });
  }
});
