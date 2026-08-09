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

function formatEntry(level: LogLevel, message: string, context?: unknown): string {
  const ts = new Date().toISOString();
  const sym = LEVEL_SYMBOLS[level];
  const ctx = context !== undefined ? ` ${JSON.stringify(context)}` : '';
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
    // GitHub tokens (ghp_, github_pat_)
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***REDACTED***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***')
    // Vercel tokens
    .replace(/Bearer [A-Za-z0-9_-]{20,}/gi, 'Bearer ***REDACTED***')
    // Generic API key patterns
    .replace(/api[_-]?key[=:]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi, 'api_key=***REDACTED***')
    // Authorization headers
    .replace(/Authorization:\s*[^\n]+/gi, 'Authorization: ***REDACTED***');
}

export default logger;
