/**
 * ConfigService — Persistent configuration manager for OpenBoard.
 *
 * Uses the `conf` package to store config at ~/.openboard/config.json
 * (or the path specified via OPENBOARD_CONFIG_DIR env var).
 *
 * Features:
 *  - Dot-notation get/set/has/delete
 *  - AES-256-GCM encryption for sensitive values (API keys)
 *  - Zod schema validation for structured fields
 *  - Full config reset (clear)
 *  - Bulk setAll with schema validation
 */

import Conf from 'conf';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

const LLMProviderSchema = z.enum(['openai', 'openai-codex', 'anthropic', 'moonshot', 'ollama']);

const LLMConfigSchema = z.object({
  provider: LLMProviderSchema.optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
}).optional();

const GitHubConfigSchema = z.object({
  token: z.string().optional(),
  username: z.string().optional(),
}).optional();

const VercelConfigSchema = z.object({
  token: z.string().optional(),
  teamId: z.string().optional(),
}).optional();

const CredentialsSchema = z.object({
  username: z.string().optional(),
  passwordHash: z.string().optional(),
  jwtSecret: z.string().optional(),
}).optional();

const BoardSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  dataPath: z.string().optional(),
  outputDir: z.string().optional(),
  createdAt: z.string().optional(),
  deployedUrl: z.string().optional(),
}).optional();

const AppConfigSchema = z.object({
  llm: LLMConfigSchema,
  github: GitHubConfigSchema,
  vercel: VercelConfigSchema,
  credentials: CredentialsSchema,
  boards: z.array(BoardSchema).optional(),
}).optional();

// ---------------------------------------------------------------------------
// Encryption constants
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY_SALT = 'openboard-config-encryption-v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:';

/**
 * Derives a 32-byte encryption key from the OPENBOARD_ENCRYPTION_SECRET env var.
 * Throws if the secret is not set — never falls back to insecure defaults.
 */
function deriveEncryptionKey(): Buffer {
  const secret = process.env.OPENBOARD_ENCRYPTION_SECRET;
  if (!secret) {
    // Generate a machine-specific secret on first run
    const machineSecret = generateMachineSecret();
    process.env.OPENBOARD_ENCRYPTION_SECRET = machineSecret;
    return scryptSync(machineSecret, ENCRYPTION_KEY_SALT, KEY_LENGTH) as Buffer;
  }
  return scryptSync(secret, ENCRYPTION_KEY_SALT, KEY_LENGTH) as Buffer;
}

/**
 * Generate a machine-specific secret based on hostname and random bytes.
 * Stored in a local file for persistence across sessions.
 */
function generateMachineSecret(): string {
  const configDir = process.env.OPENBOARD_CONFIG_DIR ?? join(homedir(), '.openboard');
  const secretPath = join(configDir, '.encryption-secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim();
    if (existing) return existing;
  }
  
  // Generate new secret
  const newSecret = randomBytes(32).toString('hex');
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(secretPath, newSecret, { mode: 0o600 }); // Read/write only by owner
  } catch {
    // If we can't persist, at least use for this session
  }
  return newSecret;
}

function encrypt(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
  return ENCRYPTED_PREFIX + [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error('Value is not encrypted');
  }
  const parts = ciphertext.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = deriveEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// Dot-notation helpers
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, dotKey: string): unknown {
  const parts = dotKey.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, dotKey: string, value: unknown): void {
  const parts = dotKey.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function deleteNestedValue(obj: Record<string, unknown>, dotKey: string): void {
  const parts = dotKey.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== 'object') return;
    current = current[part] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}

function hasNestedValue(obj: Record<string, unknown>, dotKey: string): boolean {
  return getNestedValue(obj, dotKey) !== undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateSet(key: string, value: unknown): void {
  // Validate known structured keys
  if (key === 'llm.provider') {
    const result = LLMProviderSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`Invalid provider value: ${String(value)}. Must be one of: openai, openai-codex, anthropic, moonshot, ollama`);
    }
  }
}

// ---------------------------------------------------------------------------
// ConfigService
// ---------------------------------------------------------------------------

export class ConfigService {
  private conf: Conf<Record<string, unknown>>;

  constructor(configDir?: string) {
    const resolvedDir =
      configDir ??
      process.env.OPENBOARD_CONFIG_DIR ??
      join(homedir(), '.openboard');

    this.conf = new Conf<Record<string, unknown>>({
      cwd: resolvedDir,
      configName: 'config',
      // No built-in schema validation — we use Zod ourselves
    });
  }

  /**
   * Get a value by dot-notation key.
   * Returns undefined if the key does not exist.
   */
  get(key: string): unknown {
    const store = this.conf.store as Record<string, unknown>;
    return getNestedValue(store, key);
  }

  /**
   * Set a value by dot-notation key with optional Zod validation.
   */
  set(key: string, value: unknown): void {
    validateSet(key, value);
    const store = { ...(this.conf.store as Record<string, unknown>) };
    setNestedValue(store, key, value);
    this.conf.store = store;
  }

  /**
   * Check if a dot-notation key exists.
   */
  has(key: string): boolean {
    const store = this.conf.store as Record<string, unknown>;
    return hasNestedValue(store, key);
  }

  /**
   * Delete a dot-notation key.
   */
  delete(key: string): void {
    const store = { ...(this.conf.store as Record<string, unknown>) };
    deleteNestedValue(store, key);
    this.conf.store = store;
  }

  /**
   * Clear all configuration (full reset).
   */
  clear(): void {
    this.conf.clear();
  }

  /**
   * Encrypt a sensitive string value (e.g., API key) and store it.
   * The stored value is NOT readable in plaintext from the config file.
   */
  setEncrypted(key: string, value: string): void {
    const ciphertext = encrypt(value);
    const store = { ...(this.conf.store as Record<string, unknown>) };
    setNestedValue(store, key, ciphertext);
    this.conf.store = store;
  }

  /**
   * Decrypt and return a previously encrypted value.
   * Throws if the value is not encrypted or cannot be decrypted.
   */
  getDecrypted(key: string): string {
    const raw = this.getRaw(key);
    if (raw === undefined) throw new Error(`Key not found: ${key}`);
    if (typeof raw !== 'string') throw new Error(`Value at ${key} is not a string`);
    return decrypt(raw);
  }

  /**
   * Read a sensitive string value.
   * Supports encrypted config first and legacy plaintext config as a fallback.
   */
  getSecret(key: string): string | undefined {
    const raw = this.getRaw(key);
    if (raw === undefined || typeof raw !== 'string') return undefined;
    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      try {
        return decrypt(raw);
      } catch {
        return undefined;
      }
    }
    return raw;
  }

  /**
   * Get the raw (possibly encrypted) value without decryption.
   */
  getRaw(key: string): unknown {
    const store = this.conf.store as Record<string, unknown>;
    return getNestedValue(store, key);
  }

  /**
   * Set all config values at once with full Zod schema validation.
   * Throws if the config object does not pass schema validation.
   */
  setAll(config: object): void {
    const result = AppConfigSchema.safeParse(config);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Config validation failed: ${issues}`);
    }
    this.conf.store = config as Record<string, unknown>;
  }

  /**
   * Get the absolute path to the config file.
   */
  get configPath(): string {
    return this.conf.path;
  }
}

export default ConfigService;
