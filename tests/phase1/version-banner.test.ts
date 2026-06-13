/**
 * PHASE 1: Version Banner Sync
 *
 * Guards against a recurring release mistake: bumping package.json "version"
 * but forgetting to update the hardcoded vX.Y.Z banner the CLI prints
 * (`openboard --version` and the TUI welcome screen). Every vX.Y.Z string in
 * those banner sources MUST equal the current package version, so this fails
 * locally at `npm test` / in CI before a mismatched build ever ships.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
const VERSION = pkg.version;

// Files that render the user-facing OpenBoard version banner.
const BANNER_FILES = [
  'src/index.tsx',                 // `openboard --version` output
  'src/screens/WelcomeScreen.tsx', // TUI welcome banner
  'user-manual.md',                // documented banner (ships in npm package)
];

function bannerVersions(relPath: string): string[] {
  const content = readFileSync(join(ROOT, relPath), 'utf-8');
  // Match vX.Y.Z banner strings (e.g. "v1.0.5").
  return [...content.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
}

describe('version banner sync', () => {
  it('package.json has a valid semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const relPath of BANNER_FILES) {
    it(`${relPath} prints a banner version matching package.json (${VERSION})`, () => {
      const found = bannerVersions(relPath);
      // The banner string must exist...
      expect(found.length).toBeGreaterThan(0);
      // ...and every version it prints must equal the package version.
      for (const version of found) {
        expect(version).toBe(VERSION);
      }
    });
  }
});
