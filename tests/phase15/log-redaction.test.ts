/**
 * Phase 15 — security review fixes for log redaction.
 *
 * sanitizeErrorMessage used to be opt-in at each call site, which only holds
 * as long as every author remembers; and it had no pattern for a Gmail App
 * Password, the one credential the invoice fetchers actually handle. Log lines
 * are written once and then sit on disk indefinitely, so both are pinned here.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage } from '../../src/utils/logger.js';
import { appendBillerActivity, clearBillerActivity, getBillerActivity } from '../../src/services/billers/billerActivityLog.js';

describe('sanitizeErrorMessage', () => {
  it('redacts a Gmail App Password reported next to its key name', () => {
    const out = sanitizeErrorMessage('{"email":"a@b.com","app_password":"abcdefghijklmnop"}');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('REDACTED');
  });

  it('redacts App Passwords written in the spaced groups Google displays', () => {
    const out = sanitizeErrorMessage('app_password: abcd efgh ijkl mnop');
    expect(out).not.toContain('abcd efgh ijkl mnop');
    expect(out).toContain('REDACTED');
  });

  it('leaves ordinary sixteen-letter words alone', () => {
    // The pattern anchors on the key name precisely so prose survives — a bare
    // 16-letter run is far too common to redact on sight.
    const message = 'Processing acknowledgements for the quarter';
    expect(sanitizeErrorMessage(message)).toBe(message);
  });

  it('still redacts the provider key formats it always covered', () => {
    const out = sanitizeErrorMessage('key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa and ghp_bbbbbbbbbbbbbbbbbbbbbb');
    expect(out).not.toContain('sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).not.toContain('ghp_bbbbbbbbbbbbbbbbbbbbbb');
  });
});

describe('biller activity log', () => {
  it('redacts credentials that reach it from fetcher output', () => {
    clearBillerActivity();
    // Raw stdout/stderr is forwarded verbatim from the Python fetchers, so the
    // buffer has to defend itself rather than trust its callers.
    appendBillerActivity('FileNotFoundError {"app_password": "abcdefghijklmnop"}');
    const [line] = getBillerActivity();
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).toContain('REDACTED');
    clearBillerActivity();
  });

  it('leaves ordinary progress lines untouched', () => {
    clearBillerActivity();
    appendBillerActivity('[zomato] fetching invoices…');
    expect(getBillerActivity()).toEqual(['[zomato] fetching invoices…']);
    clearBillerActivity();
  });
});
