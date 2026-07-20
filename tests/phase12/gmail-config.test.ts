/**
 * Phase 12 — Gmail integration: config schema and typed accessors.
 *
 * Gmail credentials live under gmail.* in config.json (secret fields
 * encrypted); TypedConfigRepository.getGmailSettings() applies defaults so
 * callers never re-implement fallback logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import {
  GMAIL_DEFAULT_MAX_RESULTS,
  GMAIL_DEFAULT_QUERY,
  GMAIL_DEFAULT_SYNC_INTERVAL_MINUTES,
} from '../../src/types/mail.js';

describe('gmail config schema', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-gmail-config-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'gmail-config-test';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('accepts a gmail block through setAll validation', () => {
    const cfg = new ConfigService(configDir);
    expect(() => cfg.setAll({
      gmail: {
        clientId: 'abc.apps.googleusercontent.com',
        email: 'me@example.com',
        query: 'in:inbox',
        syncIntervalMinutes: 10,
        maxResults: 100,
        needsReauth: false,
      },
    })).not.toThrow();
  });

  it('rejects out-of-range gmail sync settings', () => {
    const cfg = new ConfigService(configDir);
    expect(() => cfg.setAll({ gmail: { syncIntervalMinutes: 0 } })).toThrow(/validation failed/i);
    expect(() => cfg.setAll({ gmail: { maxResults: 501 } })).toThrow(/validation failed/i);
  });

  it('stores gmail secrets encrypted at rest', () => {
    const cfg = new ConfigService(configDir);
    cfg.setEncrypted('gmail.clientSecret', 'GOCSPX-super-secret');
    cfg.setEncrypted('gmail.refreshToken', '1//refresh-token');

    expect(String(cfg.getRaw('gmail.clientSecret'))).toMatch(/^enc:/);
    expect(String(cfg.getRaw('gmail.refreshToken'))).toMatch(/^enc:/);
    expect(cfg.getSecret('gmail.clientSecret')).toBe('GOCSPX-super-secret');
    expect(cfg.getSecret('gmail.refreshToken')).toBe('1//refresh-token');
  });
});

describe('TypedConfigRepository.getGmailSettings', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-gmail-typed-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'gmail-typed-test';
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('applies defaults when nothing is configured', () => {
    const repo = new TypedConfigRepository(new ConfigService(configDir));
    const settings = repo.getGmailSettings();

    expect(settings.clientId).toBeUndefined();
    expect(settings.query).toBe(GMAIL_DEFAULT_QUERY);
    expect(settings.syncIntervalMinutes).toBe(GMAIL_DEFAULT_SYNC_INTERVAL_MINUTES);
    expect(settings.maxResults).toBe(GMAIL_DEFAULT_MAX_RESULTS);
    expect(settings.needsReauth).toBe(false);
  });

  it('returns stored values, decrypting the client secret', () => {
    const store = new ConfigService(configDir);
    store.set('gmail.clientId', 'abc.apps.googleusercontent.com');
    store.setEncrypted('gmail.clientSecret', 'GOCSPX-super-secret');
    store.set('gmail.email', 'me@example.com');
    store.set('gmail.query', 'label:receipts');
    store.set('gmail.syncIntervalMinutes', 15);
    store.set('gmail.maxResults', 50);
    store.set('gmail.needsReauth', true);

    const settings = new TypedConfigRepository(store).getGmailSettings();
    expect(settings.clientId).toBe('abc.apps.googleusercontent.com');
    expect(settings.clientSecret).toBe('GOCSPX-super-secret');
    expect(settings.email).toBe('me@example.com');
    expect(settings.query).toBe('label:receipts');
    expect(settings.syncIntervalMinutes).toBe(15);
    expect(settings.maxResults).toBe(50);
    expect(settings.needsReauth).toBe(true);
  });
});
