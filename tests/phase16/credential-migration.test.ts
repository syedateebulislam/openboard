/**
 * Phase 16 — migrating installed fetchers off the plaintext credentials file.
 *
 * Regression cover for a real breakage: the security fix deleted
 * secrets/gmail_app_credentials.json, but installBundledScripts never
 * overwrites — deliberately, so hand-edited fetchers survive upgrades. The
 * result was that every fetcher installed before the change kept reading a file
 * that no longer existed and failed on every run.
 *
 * The migration has to repair those in place without discarding user edits,
 * and it has to be idempotent, because it runs before every fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateFetcherSource,
  migrateInstalledFetchers,
} from '../../src/services/billers/BillerDiscoveryService.js';
import { describeFetchError } from '../../src/services/billers/BillerFetcherService.js';

let root: string;
let scriptsDir: string;

/** A fetcher as shipped before the change: reads the credentials file directly. */
function legacyFetcher(key = 'zomato', extra = ''): string {
  return [
    '#!/usr/bin/env python3',
    '"""Standalone Zomato invoice fetcher."""',
    'import json',
    'import os',
    'from pathlib import Path',
    '',
    'REPO_ROOT = Path(__file__).resolve().parents[2]',
    'CREDENTIALS_PATH = REPO_ROOT / "secrets" / "gmail_app_credentials.json"',
    `KEY = "${key}"`,
    'DISPLAY_NAME = "Zomato"',
    '',
    '',
    'def read_json(path) -> dict:',
    '    with open(path, "r", encoding="utf-8") as f:',
    '        return json.load(f)',
    '',
    '',
    'def parse(text, subject):',
    extra,
    '    return {"currency": "INR"}',
    '',
    '',
    'def run(args):',
    '    credentials = read_json(CREDENTIALS_PATH)',
    '    return 0, 0',
    '',
  ].join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openboard-migrate-'));
  scriptsDir = join(root, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrateFetcherSource', () => {
  it('adds load_credentials and redirects the call in run()', () => {
    const migrated = migrateFetcherSource(legacyFetcher())!;
    expect(migrated).toContain('def load_credentials(');
    expect(migrated).toContain('credentials = load_credentials()');
    // Exactly one mention survives — the fallback inside the new helper.
    expect(migrated.match(/read_json\(CREDENTIALS_PATH\)/g)).toHaveLength(1);
  });

  it('keeps the file-based path as a standalone fallback', () => {
    // Running a fetcher by hand, outside OpenBoard, must still work.
    const migrated = migrateFetcherSource(legacyFetcher())!;
    expect(migrated).toContain('return read_json(CREDENTIALS_PATH)');
    expect(migrated).toContain('OPENBOARD_GMAIL_APP_PASSWORD');
  });

  it('preserves edits the user made to parse()', () => {
    // The reason this patches in place instead of recopying the bundled file.
    const edited = legacyFetcher('zomato', '    my_custom_marker = 42');
    const migrated = migrateFetcherSource(edited)!;
    expect(migrated).toContain('my_custom_marker = 42');
  });

  it('leaves an already-migrated fetcher alone', () => {
    const once = migrateFetcherSource(legacyFetcher())!;
    expect(migrateFetcherSource(once)).toBeUndefined();
  });

  it('never leaves load_credentials calling itself', () => {
    // The first version of this migration inserted the helper and then rewrote
    // every read_json(CREDENTIALS_PATH) — including the one inside the helper
    // it had just added, turning the fallback into infinite recursion.
    const migrated = migrateFetcherSource(legacyFetcher())!;
    const helper = /def load_credentials\(\)[\s\S]*?(?=\ndef |\Z)/.exec(migrated)![0];
    expect(helper).not.toMatch(/return\s+load_credentials\(\)/);
    expect(helper).toContain('return read_json(CREDENTIALS_PATH)');
  });

  it('repairs a fetcher already damaged by that bug', () => {
    const damaged = migrateFetcherSource(legacyFetcher())!.replace(
      'return read_json(CREDENTIALS_PATH)',
      'return load_credentials()',
    );
    const repaired = migrateFetcherSource(damaged)!;
    expect(repaired).toContain('return read_json(CREDENTIALS_PATH)');
    expect(repaired).not.toMatch(/return\s+load_credentials\(\)/);
  });

  it('leaves a fetcher that never used the file alone', () => {
    expect(migrateFetcherSource('KEY = "x"\ndef parse(t, s):\n    return {}\n')).toBeUndefined();
  });

  it('preserves CRLF line endings', () => {
    // The shipped fetchers are CRLF; rewriting them as LF would show every
    // line as changed in any diff the user looks at.
    const migrated = migrateFetcherSource(legacyFetcher().replaceAll('\n', '\r\n'))!;
    expect(migrated).toContain('\r\n');
    expect(migrated.split('\r\n').length).toBeGreaterThan(10);
    expect(/[^\r]\n/.test(migrated)).toBe(false);
  });
});

describe('migrateInstalledFetchers', () => {
  it('repairs every outdated fetcher in the folder', () => {
    for (const key of ['zomato', 'uber_rides', 'amazon']) {
      writeFileSync(join(scriptsDir, `fetch_${key}.py`), legacyFetcher(key), 'utf-8');
    }
    const migrated = migrateInstalledFetchers(scriptsDir);
    expect(migrated.sort()).toEqual(['fetch_amazon.py', 'fetch_uber_rides.py', 'fetch_zomato.py']);

    for (const file of migrated) {
      expect(readFileSync(join(scriptsDir, file), 'utf-8')).toContain('def load_credentials(');
    }
  });

  it('is idempotent, because it runs before every fetch', () => {
    writeFileSync(join(scriptsDir, 'fetch_zomato.py'), legacyFetcher(), 'utf-8');
    expect(migrateInstalledFetchers(scriptsDir)).toEqual(['fetch_zomato.py']);
    expect(migrateInstalledFetchers(scriptsDir)).toEqual([]);
  });

  it('ignores support scripts and non-fetchers', () => {
    writeFileSync(join(scriptsDir, 'probe_biller.py'), legacyFetcher(), 'utf-8');
    writeFileSync(join(scriptsDir, 'notes.txt'), 'read_json(CREDENTIALS_PATH)', 'utf-8');
    expect(migrateInstalledFetchers(scriptsDir)).toEqual([]);
  });

  it('returns nothing rather than throwing on a missing folder', () => {
    expect(migrateInstalledFetchers(join(root, 'nope'))).toEqual([]);
    expect(migrateInstalledFetchers(undefined)).toEqual([]);
  });
});

describe('describeFetchError', () => {
  it('names the real cause instead of blaming the PATH', () => {
    // A traceback ending in FileNotFoundError also contains "No such file or
    // directory", so the interpreter check used to swallow it and report a
    // missing Python — which is what sent this bug looking like an install
    // problem for a day.
    const traceback = [
      'Traceback (most recent call last):',
      '  File "fetch_zomato.py", line 244, in run',
      '    credentials = read_json(CREDENTIALS_PATH)',
      "FileNotFoundError: [Errno 2] No such file or directory: 'C:\\\\Users\\\\x\\\\secrets\\\\gmail_app_credentials.json'",
    ].join('\n');

    const message = describeFetchError(traceback);
    expect(message).not.toMatch(/Python was not found/i);
    expect(message).toMatch(/old plaintext credentials file/i);
  });

  it('still reports a genuinely missing interpreter', () => {
    expect(describeFetchError('spawn python ENOENT')).toMatch(/Python was not found/i);
    expect(describeFetchError("'python' is not recognized")).toMatch(/Python was not found/i);
  });

  it('surfaces the last line of any other traceback', () => {
    const message = describeFetchError('Traceback (most recent call last):\n  ...\nKeyError: "total_paid"');
    expect(message).toMatch(/crashed/i);
    expect(message).toContain('KeyError');
  });

  it('keeps the dependency and login diagnostics intact', () => {
    expect(describeFetchError("ModuleNotFoundError: No module named 'bs4'")).toMatch(/beautifulsoup4/);
    expect(describeFetchError('AUTHENTICATIONFAILED')).toMatch(/Gmail rejected/i);
  });
});
