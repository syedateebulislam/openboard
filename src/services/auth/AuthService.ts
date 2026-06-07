/**
 * AuthService — Password hashing and JWT secret generation for OpenBoard.
 *
 * Used during setup wizard to prepare credentials that will be stored as
 * Vercel environment variables on the deployed dashboard.
 *
 * - hashPassword: bcrypt hash with 12 rounds
 * - generateJWTSecret: 256-bit cryptographically secure random secret
 * - prepareCredentials: full credential bundle for Vercel deployment
 */

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

export class AuthService {
  /**
   * Hash a plaintext password using bcrypt with 12 cost factor rounds.
   * Returns a $2b$ prefixed bcrypt string with embedded salt.
   */
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  /**
   * Generate a 256-bit (64 hex character) cryptographically secure JWT secret.
   * Uses Node.js crypto.randomBytes for CSPRNG output.
   */
  static generateJWTSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Prepare a complete credential bundle for Vercel environment variables.
   *
   * Returns:
   *   - username: plaintext (used as OPENBOARD_USERNAME env var)
   *   - passwordHash: bcrypt hash (used as OPENBOARD_PASSWORD_HASH env var)
   *   - jwtSecret: random hex (used as OPENBOARD_JWT_SECRET env var)
   */
  static async prepareCredentials(
    username: string,
    password: string,
  ): Promise<{
    username: string;
    passwordHash: string;
    jwtSecret: string;
  }> {
    const passwordHash = await AuthService.hashPassword(password);
    const jwtSecret = AuthService.generateJWTSecret();
    return { username, passwordHash, jwtSecret };
  }
}

export default AuthService;
