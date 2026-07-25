/**
 * Phase 12 — Gmail integration: headless setup part and status reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import { SetupService } from '../../src/services/config/SetupService.js';

describe('SetupService.configureGmail', () => {
  let configDir: string;
  let config: ConfigService;
  let setup: SetupService;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-setup-gmail-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'setup-gmail-test';
    config = new ConfigService(configDir);
    setup = new SetupService(config);
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('saves credentials with the secret encrypted and points at the TUI for consent', () => {
    const result = setup.configureGmail({
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      query: 'label:receipts',
      syncIntervalMinutes: 10,
    });

    expect(result.configured).toBe(true);
    expect(result.detail).toMatch(/Settings › Gmail integration/);
    expect(config.get('gmail.clientId')).toBe('abc.apps.googleusercontent.com');
    expect(String(config.getRaw('gmail.clientSecret'))).toMatch(/^enc:/);
    expect(config.get('gmail.query')).toBe('label:receipts');
    expect(config.get('gmail.syncIntervalMinutes')).toBe(10);
  });

  it('rejects missing credentials and bad intervals', () => {
    expect(setup.configureGmail({}).configured).toBe(false);
    expect(setup.configureGmail({ clientId: 'id-only' }).configured).toBe(false);
    const badInterval = setup.configureGmail({
      clientId: 'abc',
      clientSecret: 'shh',
      syncIntervalMinutes: 0,
    });
    expect(badInterval.configured).toBe(false);
    expect(badInterval.errorCode).toBe('E_VALIDATION');
  });

  it('status reports gmail as null, saved, and connected', () => {
    expect(setup.status().gmail).toBeNull();

    setup.configureGmail({ clientId: 'abc', clientSecret: 'shh' });
    expect(setup.status().gmail).toEqual({ email: undefined, connected: false });

    config.setEncrypted('gmail.refreshToken', 'rt-1');
    config.set('gmail.email', 'me@example.com');
    expect(setup.status().gmail).toEqual({ email: 'me@example.com', connected: true });

    config.set('gmail.needsReauth', true);
    expect(setup.status().gmail?.connected).toBe(false);
  });
});
