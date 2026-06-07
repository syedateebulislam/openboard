/**
 * PHASE 1: ConfigService Tests
 *
 * Tests dot-notation config, encryption, validation, and lifecycle.
 * Uses real temp directories — no mocking needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ConfigService } from '../../src/services/config/ConfigService.js';

describe('ConfigService', () => {
  let tempDir: string;
  let cfg: ConfigService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openboard-cfg-test-'));
    // Set encryption secret for deterministic tests
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'test-secret-key-for-unit-tests-32b';
    cfg = new ConfigService(tempDir);
  });

  afterEach(async () => {
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    delete process.env.OPENBOARD_CONFIG_DIR;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('Initialization', () => {
    it('should be usable after instantiation', () => {
      // ConfigService should be ready to use immediately after construction
      expect(cfg.configPath).toBeTruthy();
      // Setting a value should create the config store
      cfg.set('init.test', true);
      expect(cfg.get('init.test')).toBe(true);
    });

    it('should load existing config without overwriting user values', () => {
      cfg.set('custom.key', 'my-value');

      // Create new instance pointing to same dir
      const cfg2 = new ConfigService(tempDir);
      expect(cfg2.get('custom.key')).toBe('my-value');
    });
  });

  // -------------------------------------------------------------------------
  // Read/Write Operations
  // -------------------------------------------------------------------------

  describe('Read/Write Operations', () => {
    it('should set and get a top-level value', () => {
      cfg.set('version', '1.0.0');
      expect(cfg.get('version')).toBe('1.0.0');
    });

    it('should support dot notation for nested keys', () => {
      cfg.set('boards.health.dataPath', '/data/health.csv');
      expect(cfg.get('boards.health.dataPath')).toBe('/data/health.csv');
    });

    it('should return undefined for keys that do not exist', () => {
      expect(cfg.get('nonexistent.key')).toBeUndefined();
    });

    it('should overwrite existing values on set', () => {
      cfg.set('theme', 'dark');
      cfg.set('theme', 'light');
      expect(cfg.get('theme')).toBe('light');
    });

    it('should delete a key and return undefined after deletion', () => {
      cfg.set('temp.value', 42);
      expect(cfg.get('temp.value')).toBe(42);
      cfg.delete('temp.value');
      expect(cfg.get('temp.value')).toBeUndefined();
    });

    it('should store and retrieve array values', () => {
      const arr = ['openai', 'anthropic', 'ollama'];
      cfg.set('providers.list', arr);
      expect(cfg.get('providers.list')).toEqual(arr);
    });
  });

  // -------------------------------------------------------------------------
  // Encryption
  // -------------------------------------------------------------------------

  describe('API Key Encryption', () => {
    it('should encrypt values and decrypt on retrieval', () => {
      cfg.setEncrypted('llm.apiKey', 'sk-test-key-12345');

      // Raw value should not be the plaintext
      const raw = cfg.getRaw('llm.apiKey');
      expect(raw).not.toBe('sk-test-key-12345');
      expect(typeof raw).toBe('string');
      expect((raw as string).startsWith('enc:')).toBe(true);

      // Decrypted value should match original
      expect(cfg.getDecrypted('llm.apiKey')).toBe('sk-test-key-12345');
    });

    it('should produce different ciphertext for different values', () => {
      cfg.setEncrypted('key1', 'value-one');
      cfg.setEncrypted('key2', 'value-two');

      const raw1 = cfg.getRaw('key1') as string;
      const raw2 = cfg.getRaw('key2') as string;
      expect(raw1).not.toBe(raw2);
    });

    it('should read encrypted secrets and fall back to legacy plaintext values', () => {
      cfg.setEncrypted('credentials.passwordHash', 'hash-value');
      cfg.set('legacy.secret', 'plain-value');
      cfg.set('unreadable.secret', 'enc:not-valid');

      expect(cfg.getSecret('credentials.passwordHash')).toBe('hash-value');
      expect(cfg.getSecret('legacy.secret')).toBe('plain-value');
      expect(cfg.getSecret('missing.secret')).toBeUndefined();
      expect(cfg.getSecret('unreadable.secret')).toBeUndefined();
    });

    it('should persist generated encryption secrets across service instances', () => {
      delete process.env.OPENBOARD_ENCRYPTION_SECRET;
      process.env.OPENBOARD_CONFIG_DIR = tempDir;

      const first = new ConfigService(tempDir);
      first.setEncrypted('vercel.token', 'vcp_test_token_123');

      const second = new ConfigService(tempDir);
      expect(second.getSecret('vercel.token')).toBe('vcp_test_token_123');
      expect(existsSync(join(tempDir, '.encryption-secret'))).toBe(true);
    });

    it('should throw when decrypting non-existent key', () => {
      expect(() => cfg.getDecrypted('missing.key')).toThrow(/Key not found/);
    });
  });

  // -------------------------------------------------------------------------
  // Schema Validation
  // -------------------------------------------------------------------------

  describe('Schema Validation', () => {
    it('should reject invalid provider values', () => {
      expect(() => cfg.set('llm.provider', 'invalid-provider')).toThrow(/Invalid provider/);
    });

    it('should accept valid provider values', () => {
      expect(() => cfg.set('llm.provider', 'openai')).not.toThrow();
      expect(cfg.get('llm.provider')).toBe('openai');
      expect(() => cfg.set('llm.provider', 'openai-codex')).not.toThrow();
      expect(cfg.get('llm.provider')).toBe('openai-codex');
    });
  });

  // -------------------------------------------------------------------------
  // Has / Clear
  // -------------------------------------------------------------------------

  describe('Has / Clear Operations', () => {
    it('should return true for existing keys, false for missing', () => {
      cfg.set('exists', true);
      expect(cfg.has('exists')).toBe(true);
      expect(cfg.has('does.not.exist')).toBe(false);
    });

    it('should clear all config', () => {
      cfg.set('a', 1);
      cfg.set('b', 2);
      cfg.set('c.d', 3);
      cfg.clear();
      expect(cfg.get('a')).toBeUndefined();
      expect(cfg.get('b')).toBeUndefined();
      expect(cfg.get('c.d')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // configPath property
  // -------------------------------------------------------------------------

  describe('configPath', () => {
    it('should return path inside the config directory', () => {
      expect(cfg.configPath).toContain(tempDir);
    });
  });
});
