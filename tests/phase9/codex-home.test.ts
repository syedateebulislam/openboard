/**
 * Phase 9 — OpenAI Codex auth isolation.
 *
 * OpenBoard runs codex with its own CODEX_HOME so its ChatGPT/Codex login is
 * not invalidated by OpenClaw or manual `codex` usage rotating a shared token.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexHome, isCodexAuthError } from '../../src/services/llm/OpenAICodexProvider.js';

describe('Codex auth isolation', () => {
  const savedHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  });

  it('defaults to a dedicated home under ~/.openboard, separate from ~/.codex', () => {
    delete process.env.CODEX_HOME;
    const home = codexHome();
    expect(home).toBe(join(homedir(), '.openboard', 'codex-home'));
    expect(home).not.toBe(join(homedir(), '.codex'));
    expect(existsSync(home)).toBe(true); // created on access
  });

  it('honors an explicit CODEX_HOME as an opt-out and creates it', () => {
    const custom = join(tmpdir(), `openboard-codex-${randomUUID().slice(0, 8)}`);
    process.env.CODEX_HOME = custom;
    try {
      expect(codexHome()).toBe(custom);
      expect(existsSync(custom)).toBe(true);
    } finally {
      try { rmSync(custom, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('detects codex auth/expiry errors, not normal failures', () => {
    for (const msg of [
      'Not logged in. Please run `codex login`.',
      'request failed: 401 Unauthorized',
      'no credentials found in auth.json',
      'authentication required',
    ]) {
      expect(isCodexAuthError(msg)).toBe(true);
    }
    expect(isCodexAuthError('Build failed: vite error in App.tsx')).toBe(false);
    expect(isCodexAuthError(undefined)).toBe(false);
  });
});
