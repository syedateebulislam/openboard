/**
 * Phase 10 — Secret storage hardening (security review finding #6).
 *
 * Legacy plaintext secrets in config.json must be transparently migrated to
 * encrypted storage the first time they are read, so config files at rest
 * converge to encrypted-only secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';

describe('ConfigService secret migration', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-secrets-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'secret-migration-test';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('keeps returning encrypted secrets round-trip', () => {
    const cfg = new ConfigService(configDir);
    cfg.setEncrypted('vercel.token', 'vcp_token_123');

    expect(cfg.getSecret('vercel.token')).toBe('vcp_token_123');
    expect(String(cfg.getRaw('vercel.token'))).toMatch(/^enc:/);
  });

  it('still reads legacy plaintext secrets', () => {
    const cfg = new ConfigService(configDir);
    cfg.set('github.token', 'ghp_legacy_plaintext');

    expect(cfg.getSecret('github.token')).toBe('ghp_legacy_plaintext');
  });

  it('re-encrypts legacy plaintext secrets on first read', () => {
    const cfg = new ConfigService(configDir);
    cfg.set('github.token', 'ghp_legacy_plaintext');

    // First read migrates...
    expect(cfg.getSecret('github.token')).toBe('ghp_legacy_plaintext');

    // ...so the value at rest is no longer plaintext,
    const raw = String(new ConfigService(configDir).getRaw('github.token'));
    expect(raw).toMatch(/^enc:/);
    expect(readFileSync(join(configDir, 'config.json'), 'utf-8')).not.toContain('ghp_legacy_plaintext');

    // ...and later reads still decrypt correctly.
    expect(new ConfigService(configDir).getSecret('github.token')).toBe('ghp_legacy_plaintext');
  });

  it('returns undefined for undecryptable values instead of throwing', () => {
    const cfg = new ConfigService(configDir);
    cfg.set('vercel.token', 'enc:not-a-real-ciphertext');

    expect(cfg.getSecret('vercel.token')).toBeUndefined();
  });
});
