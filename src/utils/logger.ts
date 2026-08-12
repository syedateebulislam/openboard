/**
 * logger.ts — Structured logger for OpenBoardCLI TUI and services.
 *
 * Writes to:
 *  - Terminal (via chalk, only when not in test mode)
 *  - Log file (~/.openboard/openboard.log) for persistent debugging
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

const LEVEL_SYMBOLS: Record<LogLevel, string> = {
  debug:   '[DEBUG]',
  info:    '[INFO] ',
  warn:    '[WARN] ',
  error:   '[ERROR]',
  success: '[OK]   ',
};

const IS_TEST = process.env.OPENBOARD_TEST_MODE === 'true';

function getLogFile(): string {
  const configDir = process.env.OPENBOARD_CONFIG_DIR ?? join(homedir(), '.openboard');
  return join(configDir, 'openboard.log');
}

/**
 * Render a log context without ever throwing.
 *
 * JSON.stringify throws on a circular reference or a getter that throws, and
 * the objects most likely to be logged are exactly the ones at risk: an Error
 * with a `cause` chain, a socket, an SDK error carrying its own request. That
 * turned a logging call inside a catch block into the thing that crashed the
 * process — the failure mode logging exists to prevent.
 */
function describeContext(context: unknown): string {
  // A circular-safe replacer rather than a bare stringify: the point of the
  // context is the diagnostic detail, so dropping only the cycle beats
  // dropping the whole object down to "[object Object]".
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(context, (_key, value: unknown) => {
        if (typeof value === 'bigint') return `${value}n`;
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[circular]';
          seen.add(value);
        }
        return value;
      }) ?? String(context)
    );
  } catch {
    // A throwing getter defeats the replacer too — it throws while the value
    // is being read, before the replacer ever sees it.
    try {
      return String(context);
    } catch {
      return '[unserializable]';
    }
  }
}

function formatEntry(level: LogLevel, message: string, context?: unknown): string {
  const ts = new Date().toISOString();
  const sym = LEVEL_SYMBOLS[level];
  const ctx = context !== undefined ? ` ${describeContext(context)}` : '';
  // Redact here rather than at call sites. Sanitizing was previously opt-in,
  // which only works as long as every author remembers — and a log line is
  // written once but read from disk indefinitely.
  return sanitizeErrorMessage(`${ts} ${sym} ${message}${ctx}`);
}

/** Rotate at 5 MB, keeping one previous generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Roll the log over once it passes the size cap, so a long-lived install does
 * not accumulate an unbounded file of operational detail on disk.
 */
async function rotateIfOversized(logFile: string): Promise<void> {
  try {
    const { size } = await stat(logFile);
    if (size < MAX_LOG_BYTES) return;
    await rename(logFile, `${logFile}.1`); // replaces any previous generation
  } catch {
    // No file yet, or the rename lost a race with another process — either way
    // appending is still the right next step.
  }
}

async function writeToFile(entry: string): Promise<void> {
  try {
    const logFile = getLogFile();
    await mkdir(dirname(logFile), { recursive: true });
    await rotateIfOversized(logFile);
    await appendFile(logFile, entry + '\n', 'utf-8');
  } catch {
    // Silently ignore log write failures — never crash the app due to logging
  }
}

export class Logger {
  private prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix ? `[${prefix}] ` : '';
  }

  private log(level: LogLevel, message: string, context?: unknown): void {
    const fullMessage = this.prefix + message;
    const entry = formatEntry(level, fullMessage, context);

    // Write to file always (except in test mode to avoid noise)
    if (!IS_TEST) {
      writeToFile(entry).catch(() => {});
    }

    // Console output only when not in test mode
    if (!IS_TEST) {
      if (level === 'error' || level === 'warn') {
        console.error(entry);
      } else {
        console.log(entry);
      }
    }
  }

  debug(message: string, context?: unknown): void {
    if (process.env.OPENBOARD_DEBUG === 'true') {
      this.log('debug', message, context);
    }
  }

  info(message: string, context?: unknown): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: unknown): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: unknown): void {
    this.log('error', message, context);
  }

  success(message: string, context?: unknown): void {
    this.log('success', message, context);
  }
}

/** Default singleton logger instance */
export const logger = new Logger();

/** Create a namespaced logger for a specific module */
export function createLogger(name: string): Logger {
  return new Logger(name);
}

/**
 * Sanitize error messages to remove sensitive information like API keys.
 * Use this before logging or displaying errors to users.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    // Gmail App Passwords: 16 lowercase letters, often shown in groups of four.
    // No prefix to anchor on, so anchor on the surrounding key name instead —
    // a bare 16-letter word is far too common to redact on sight.
    .replace(
      /(app[_-]?password["']?\s*[=:]\s*["']?)[a-z]{4}[\s-]?[a-z]{4}[\s-]?[a-z]{4}[\s-]?[a-z]{4}/gi,
      '$1***REDACTED***',
    )
    // Anthropic API keys (sk-ant-...) — must come before generic sk- pattern
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***REDACTED***')
    // OpenAI API keys (sk-...)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***REDACTED***')
    // GitHub tokens (ghp_, github_pat_) — and the other prefixes GitHub issues
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***REDACTED***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***')
    .replace(/gh[oprsu]_[A-Za-z0-9_]{20,}/g, 'gh*_***REDACTED***')
    // Google / Gemini API keys. GeminiProvider is a shipped provider, so these
    // reach the same code paths every other key does.
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, 'AIza***REDACTED***')
    // bcrypt hashes — credentials.passwordHash travels through the deploy path.
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '***REDACTED-BCRYPT***')
    // Encrypted config blobs: enc:<iv>:<authTag>:<ciphertext>.
    .replace(/\benc:[0-9a-f]{16,}:[0-9a-f]{16,}:[0-9a-f]+/gi, 'enc:***REDACTED***')
    // JWTs
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***REDACTED-JWT***')
    // Vercel tokens
    .replace(/Bearer [A-Za-z0-9_-]{20,}/gi, 'Bearer ***REDACTED***')
    // Generic secret-bearing key/value pairs. Anchored on the key name rather
    // than the value's shape, which is what catches the ones with no
    // distinctive prefix: a bare Vercel token, a --token flag, the 64-hex
    // jwtSecret, a password echoed into a command line.
    //
    // The leading [\w.]* is load-bearing: contexts are logged as JSON, so the
    // real key is `jwtSecret` or `vercel.token`, and a plain \bsecret\b anchor
    // would not match either of them.
    // The key name is kept — a redacted line still has to be worth reading.
    // The lookahead leaves values the rules above already handled alone, so a
    // `ghp_***REDACTED***` marker is not flattened into a less specific one.
    .replace(
      /\b([\w.]*(?:api[_-]?key|token|secret|password|passwd|pwd))\b(["']?\s*[=:]\s*["']?)(?![^\s"',;}]*\*{3}REDACTED)[^\s"',;}]{8,}/gi,
      '$1$2***REDACTED***',
    )
    // The same secrets in CLI flag form, where the separator is a space rather
    // than = or :. Requiring the leading -- is what keeps this off ordinary
    // prose: "secret handshake protocol" must not lose a word.
    .replace(
      /(--[\w-]*(?:api[-_]?key|token|secret|password|passwd|pwd)[= ])(?![^\s"',;]*\*{3}REDACTED)[^\s"',;]{8,}/gi,
      '$1***REDACTED***',
    )
    // Authorization headers
    .replace(/Authorization:\s*[^\n]+/gi, 'Authorization: ***REDACTED***');
}

export default logger;
