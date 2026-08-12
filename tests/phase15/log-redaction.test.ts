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

  it('redacts a Gemini key, which a shipped provider issues', () => {
    const out = sanitizeErrorMessage('GeminiProvider failed with AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r');
    expect(out).not.toContain('AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r');
    expect(out).toContain('REDACTED');
  });

  it('redacts a bcrypt hash on the deploy path', () => {
    const hash = '$2b$12$W92ySjltBQ9DVXohMSLK0uqzKDN8dHd3T8qhx0oB.s8HHQWQWA6Ia';
    const out = sanitizeErrorMessage(`writing DASHBOARD_PASSWORD_HASH=${hash}`);
    expect(out).not.toContain(hash);
  });

  it('redacts an encrypted config blob', () => {
    const blob = 'enc:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeefcafe';
    expect(sanitizeErrorMessage(`llm.apiKey=${blob}`)).not.toContain('deadbeefcafe');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abc123def456';
    expect(sanitizeErrorMessage(`Set-Cookie: auth_token=${jwt}`)).not.toContain(jwt);
  });

  it('redacts secrets that have no distinctive prefix, by their key name', () => {
    // A Vercel token and the 64-hex jwtSecret look like ordinary strings; the
    // only reliable signal is what they are called.
    const cases: Array<[string, string]> = [
      ['vercel.token=AbCdEfGhIjKlMnOpQrStUvWx', 'AbCdEfGhIjKlMnOpQrStUvWx'],
      ['--token QwErTyUiOpAsDfGhJkLzXcVb', 'QwErTyUiOpAsDfGhJkLzXcVb'],
      ['password: hunter2hunter2', 'hunter2hunter2'],
    ];
    for (const [input, secret] of cases) {
      expect(sanitizeErrorMessage(input), input).not.toContain(secret);
    }
  });

  it('redacts a camelCase secret key inside a JSON context', () => {
    // Contexts are logged as JSON.stringify output, so the key is `jwtSecret`,
    // not `secret` — a plain word-boundary anchor would miss it entirely.
    const secret = 'a'.repeat(64);
    const out = sanitizeErrorMessage(`{"jwtSecret":"${secret}","username":"admin"}`);
    expect(out).not.toContain(secret);
    // The key name survives so the line is still worth reading.
    expect(out).toContain('jwtSecret');
    expect(out).toContain('admin');
  });

  it('leaves a content hash alone', () => {
    // Biller change-detection logs SHA-256 digests. Redacting those by shape
    // would cost real debuggability and protect nothing.
    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(sanitizeErrorMessage(`csv unchanged (${digest})`)).toContain(digest);
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
