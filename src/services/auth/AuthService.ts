/**
 * AuthService — Password hashing and JWT secret generation for OpenBoardCLI.
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
   *   - username: plaintext (deployed as DASHBOARD_USERNAME)
   *   - passwordHash: bcrypt hash (deployed as DASHBOARD_PASSWORD_HASH_B64,
   *     base64-encoded so dotenv and shell expansion leave its $ alone)
   *   - jwtSecret: random hex (deployed as JWT_SECRET)
   *
   * Those are the names VercelService writes and the generated app reads; see
   * types/deployment.ts and templates/dashboard/api/auth.ts. This comment
   * previously named OPENBOARD_-prefixed variables, which are set nowhere.
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
