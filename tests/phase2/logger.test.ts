/**
 * PHASE 2: Logger Tests
 *
 * Tests sanitizeErrorMessage (pure function) and Logger/createLogger basics.
 * No mocking needed for sanitizeErrorMessage — it's pure string transformation.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage, Logger, createLogger } from '../../src/utils/logger.js';

describe('sanitizeErrorMessage', () => {
  it('should redact OpenAI API keys (sk-...)', () => {
    const msg = 'Error: Invalid key sk-abc123def456ghi789jkl012mno';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).not.toContain('sk-abc123');
    expect(sanitized).toContain('sk-***REDACTED***');
  });

  it('should redact Anthropic API keys (sk-ant-...)', () => {
    const msg = 'Auth failed: sk-ant-api03-abcdefghij1234567890abcdef';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).not.toContain('sk-ant-api03');
    expect(sanitized).toContain('sk-ant-***REDACTED***');
  });

  it('should redact GitHub personal access tokens (ghp_...)', () => {
    const msg = 'Push failed with token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).not.toContain('ghp_AbCdEf');
    expect(sanitized).toContain('ghp_***REDACTED***');
  });

  it('should redact GitHub fine-grained tokens (github_pat_...)', () => {
    const msg = 'Token: github_pat_11ABCDEF_abcdefghijklmnopqrstuvwxyz';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).not.toContain('github_pat_11ABCDEF');
    expect(sanitized).toContain('github_pat_***REDACTED***');
  });

  it('should redact Bearer tokens', () => {
    const msg = 'Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).toContain('Bearer ***REDACTED***');
    expect(sanitized).not.toContain('eyJhbGci');
  });

  it('should redact generic api_key patterns', () => {
    const msg = 'Config: api_key=ABCDEF1234567890GHIJ';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).toContain('api_key=***REDACTED***');
    expect(sanitized).not.toContain('ABCDEF1234567890');
  });

  it('should redact Authorization headers', () => {
    const msg = 'Request failed\nAuthorization: Token abc123secret456\nStatus: 401';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).toContain('Authorization: ***REDACTED***');
    expect(sanitized).not.toContain('abc123secret456');
  });

  it('should not modify messages without sensitive data', () => {
    const msg = 'Connection timeout after 30s';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('should handle multiple keys in one message', () => {
    const msg = 'Keys: sk-abc123def456ghi789jkl012mno and ghp_AbCdEfGhIjKlMnOpQrStUvWxYz';
    const sanitized = sanitizeErrorMessage(msg);
    expect(sanitized).toContain('sk-***REDACTED***');
    expect(sanitized).toContain('ghp_***REDACTED***');
  });

  it('should handle empty string', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });
});

describe('Logger', () => {
  it('should create a logger instance', () => {
    const log = new Logger();
    expect(log).toBeInstanceOf(Logger);
  });

  it('should create a namespaced logger via createLogger', () => {
    const log = createLogger('TestModule');
    expect(log).toBeInstanceOf(Logger);
  });
});
