/**
 * Phase 12 — Gmail integration: OAuth loopback auth service.
 *
 * The consent flow is exercised end-to-end against the real loopback server:
 * the injected openBrowserImpl plays the role of the browser by calling the
 * redirect URI, while fetchImpl mocks Google's token and profile endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import {
  GmailAuthService,
  GmailReauthRequiredError,
  generatePkcePair,
} from '../../src/services/mail/GmailAuthService.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Simulate the browser: extract redirect_uri from the consent URL and hit the callback. */
function browserThatApproves(overrides: { state?: string; code?: string } = {}) {
  return (consentUrl: string) => {
    const params = new URL(consentUrl).searchParams;
    const redirectUri = params.get('redirect_uri')!;
    const state = overrides.state ?? params.get('state')!;
    const code = overrides.code ?? 'auth-code-123';
    void fetch(`${redirectUri}?${new URLSearchParams({ state, code }).toString()}`);
  };
}

describe('GmailAuthService', () => {
  let configDir: string;
  let store: ConfigService;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-gmail-auth-'));
    process.env.OPENBOARD_CONFIG_DIR = configDir;
    process.env.OPENBOARD_ENCRYPTION_SECRET = 'gmail-auth-test';
    store = new ConfigService(configDir);
    store.set('gmail.clientId', 'client-id.apps.googleusercontent.com');
    store.setEncrypted('gmail.clientSecret', 'GOCSPX-secret');
  });

  afterEach(() => {
    delete process.env.OPENBOARD_CONFIG_DIR;
    delete process.env.OPENBOARD_ENCRYPTION_SECRET;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('generates a valid S256 PKCE pair', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('completes the loopback consent flow and stores the refresh token encrypted', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url === TOKEN_ENDPOINT) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (url === PROFILE_ENDPOINT) {
        return jsonResponse({ emailAddress: 'me@example.com' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const auth = new GmailAuthService({ store, fetchImpl, openBrowserImpl: browserThatApproves() });
    const result = await auth.connectInteractive();

    expect(result.email).toBe('me@example.com');
    expect(store.get('gmail.email')).toBe('me@example.com');
    expect(String(store.getRaw('gmail.refreshToken'))).toMatch(/^enc:/);
    expect(store.getSecret('gmail.refreshToken')).toBe('rt-1');
    expect(auth.isConfigured()).toBe(true);

    const tokenCall = calls.find((c) => c.url === TOKEN_ENDPOINT);
    expect(tokenCall?.body).toContain('grant_type=authorization_code');
    expect(tokenCall?.body).toContain('code=auth-code-123');
    expect(tokenCall?.body).toContain('code_verifier=');
  });

  it('rejects the consent flow on state mismatch', async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const auth = new GmailAuthService({
      store,
      fetchImpl,
      openBrowserImpl: browserThatApproves({ state: 'forged-state' }),
    });

    await expect(auth.connectInteractive()).rejects.toThrow(/state mismatch/i);
    expect(auth.isConfigured()).toBe(false);
  });

  it('refreshes the access token once and caches it in memory', async () => {
    store.setEncrypted('gmail.refreshToken', 'rt-stored');
    let refreshCalls = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshCalls += 1;
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('refresh_token=rt-stored');
      return jsonResponse({ access_token: 'at-fresh', expires_in: 3600 });
    }) as typeof fetch;

    const auth = new GmailAuthService({ store, fetchImpl });
    expect(await auth.getAccessToken()).toBe('at-fresh');
    expect(await auth.getAccessToken()).toBe('at-fresh');
    expect(refreshCalls).toBe(1);
  });

  it('marks needsReauth and throws a typed error on invalid_grant', async () => {
    store.setEncrypted('gmail.refreshToken', 'rt-revoked');
    const fetchImpl = (async () => jsonResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;

    const auth = new GmailAuthService({ store, fetchImpl });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GmailReauthRequiredError);
    expect(store.get('gmail.needsReauth')).toBe(true);
    expect(auth.isConfigured()).toBe(false);
  });

  it('disconnect revokes best-effort and removes stored credentials', async () => {
    store.setEncrypted('gmail.refreshToken', 'rt-1');
    store.set('gmail.email', 'me@example.com');
    const revoked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      revoked.push(String(input));
      return jsonResponse({});
    }) as typeof fetch;

    const auth = new GmailAuthService({ store, fetchImpl });
    await auth.disconnect();

    expect(revoked[0]).toContain('https://oauth2.googleapis.com/revoke');
    expect(store.get('gmail.refreshToken')).toBeUndefined();
    expect(store.get('gmail.email')).toBeUndefined();
    // Client id/secret survive disconnect so reconnecting skips re-entry.
    expect(auth.hasCredentials()).toBe(true);
  });
});
