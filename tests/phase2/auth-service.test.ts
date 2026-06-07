/**
 * PHASE 2: AuthService Tests
 *
 * Tests password hashing, JWT secret generation, and credential preparation.
 * Uses real bcryptjs — no mocking needed.
 */

import { describe, it, expect } from 'vitest';
import { AuthService } from '../../src/services/auth/AuthService.js';
import bcrypt from 'bcryptjs';

describe('AuthService', () => {
  describe('Password Hashing', () => {
    it('should produce a valid bcrypt hash', async () => {
      const hash = await AuthService.hashPassword('testpassword');
      expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    });

    it('should verify the original password against its hash', async () => {
      const password = 'my-secure-password';
      const hash = await AuthService.hashPassword(password);
      const valid = await bcrypt.compare(password, hash);
      expect(valid).toBe(true);
    });

    it('should not verify an incorrect password', async () => {
      const hash = await AuthService.hashPassword('correct-password');
      const valid = await bcrypt.compare('wrong-password', hash);
      expect(valid).toBe(false);
    });

    it('should produce different hashes for the same password (random salt)', async () => {
      const hash1 = await AuthService.hashPassword('same-password');
      const hash2 = await AuthService.hashPassword('same-password');
      expect(hash1).not.toBe(hash2);
    });

    it('should use cost factor of 12 rounds', async () => {
      const hash = await AuthService.hashPassword('test');
      // bcrypt hash format: $2b$12$...
      expect(hash).toContain('$12$');
    });
  });

  describe('JWT Secret Generation', () => {
    it('should generate a 64-character hex string', () => {
      const secret = AuthService.generateJWTSecret();
      expect(secret).toHaveLength(64);
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce unique secrets on each call', () => {
      const s1 = AuthService.generateJWTSecret();
      const s2 = AuthService.generateJWTSecret();
      expect(s1).not.toBe(s2);
    });
  });

  describe('Credential Preparation', () => {
    it('should return username, passwordHash, and jwtSecret', async () => {
      const creds = await AuthService.prepareCredentials('admin', 'pass123');
      expect(creds).toHaveProperty('username');
      expect(creds).toHaveProperty('passwordHash');
      expect(creds).toHaveProperty('jwtSecret');
    });

    it('should preserve username as plaintext', async () => {
      const creds = await AuthService.prepareCredentials('myuser', 'pass');
      expect(creds.username).toBe('myuser');
    });

    it('should hash the password (not store plaintext)', async () => {
      const creds = await AuthService.prepareCredentials('user', 'secret');
      expect(creds.passwordHash).not.toBe('secret');
      expect(creds.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('should generate a valid JWT secret', async () => {
      const creds = await AuthService.prepareCredentials('user', 'pass');
      expect(creds.jwtSecret).toHaveLength(64);
      expect(creds.jwtSecret).toMatch(/^[a-f0-9]+$/);
    });
  });
});
