/**
 * GmailAuthService — OAuth 2.0 Desktop-app loopback flow for the Gmail API.
 *
 * No googleapis dependency: token endpoints are plain fetch POSTs, the
 * redirect is a one-shot node:http server on 127.0.0.1, and PKCE comes from
 * node:crypto. Secrets (client secret, refresh token) are stored encrypted
 * via ConfigService; the access token lives in memory only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ConfigService } from '../config/ConfigService.js';
import { openBrowser } from '../../utils/openBrowser.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

// gmail.readonly, not gmail.metadata: the metadata scope rejects the q=
// parameter on messages.list, which incremental sync depends on.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const CONSENT_TIMEOUT_MS = 2 * 60 * 1000;
/** Refresh the in-memory access token this long before Google's expiry. */
const EXPIRY_SKEW_MS = 60 * 1000;

/** The stored refresh token was revoked/expired — user must reconnect. */
export class GmailReauthRequiredError extends Error {
  constructor(message = 'Gmail authorization expired — reconnect in Settings › Gmail integration.') {
    super(message);
    this.name = 'GmailReauthRequiredError';
  }
}

export interface GmailAuthStatus {
  email?: string;
  connected: boolean;
  needsReauth: boolean;
}

export interface GmailAuthDeps {
  store?: ConfigService;
  fetchImpl?: typeof fetch;
  openBrowserImpl?: (url: string) => void;
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class GmailAuthService {
  private readonly store: ConfigService;
  private readonly fetchImpl: typeof fetch;
  private readonly openBrowserImpl: (url: string) => void;
  private memoryToken?: { token: string; expiresAt: number };

  constructor(deps: GmailAuthDeps = {}) {
    this.store = deps.store ?? new ConfigService();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.openBrowserImpl = deps.openBrowserImpl ?? openBrowser;
  }

  /** Client id + secret saved (connection may or may not have happened yet). */
  hasCredentials(): boolean {
    return Boolean(this.store.get('gmail.clientId') && this.store.getSecret('gmail.clientSecret'));
  }

  /** Fully connected: credentials plus a refresh token that has not been flagged stale. */
  isConfigured(): boolean {
    return this.hasCredentials()
      && Boolean(this.store.getSecret('gmail.refreshToken'))
      && this.store.get('gmail.needsReauth') !== true;
  }

  status(): GmailAuthStatus {
    return {
      email: this.store.get('gmail.email') as string | undefined,
      connected: this.isConfigured(),
      needsReauth: this.store.get('gmail.needsReauth') === true,
    };
  }

  /**
   * Run the interactive consent flow: loopback server, browser consent,
   * code→token exchange, profile lookup, encrypted persistence.
   */
  async connectInteractive(onProgress?: (line: string) => void): Promise<{ email: string }> {
    const clientId = this.store.get('gmail.clientId') as string | undefined;
    const clientSecret = this.store.getSecret('gmail.clientSecret');
    if (!clientId || !clientSecret) {
      throw new Error('Gmail OAuth client not configured. Enter a Google Cloud OAuth client ID and secret first.');
    }

    const state = randomBytes(16).toString('base64url');
    const { verifier, challenge } = generatePkcePair();

    let server: Server | undefined;
    try {
      const { port, codePromise } = await this.startLoopbackServer(state, (s) => { server = s; });
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

      const consentUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()}`;

      onProgress?.('Opening browser for Google consent…');
      onProgress?.(`If it does not open, visit: ${consentUrl}`);
      this.openBrowserImpl(consentUrl);

      const code = await codePromise;
      onProgress?.('Authorization received — exchanging for tokens…');

      const tokens = await this.postToken({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error(`Google did not return tokens: ${tokens.error_description ?? tokens.error ?? 'unknown error'}`);
      }

      this.rememberAccessToken(tokens);
      const email = await this.fetchProfileEmail(tokens.access_token);

      this.store.setEncrypted('gmail.refreshToken', tokens.refresh_token);
      this.store.set('gmail.email', email);
      this.store.delete('gmail.needsReauth');
      onProgress?.(`Connected as ${email}`);
      return { email };
    } finally {
      server?.close();
    }
  }

  /**
   * Return a valid access token, refreshing via the stored refresh token when
   * the in-memory one is missing or near expiry.
   */
  async getAccessToken(): Promise<string> {
    if (this.memoryToken && Date.now() < this.memoryToken.expiresAt) {
      return this.memoryToken.token;
    }
    const clientId = this.store.get('gmail.clientId') as string | undefined;
    const clientSecret = this.store.getSecret('gmail.clientSecret');
    const refreshToken = this.store.getSecret('gmail.refreshToken');
    if (!clientId || !clientSecret || !refreshToken) {
      throw new GmailReauthRequiredError('Gmail is not connected. Connect in Settings › Gmail integration.');
    }

    const tokens = await this.postToken({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!tokens.access_token) {
      if (tokens.error === 'invalid_grant') {
        this.store.set('gmail.needsReauth', true);
        throw new GmailReauthRequiredError();
      }
      throw new Error(`Gmail token refresh failed: ${tokens.error_description ?? tokens.error ?? 'unknown error'}`);
    }
    this.rememberAccessToken(tokens);
    return tokens.access_token;
  }

  /** Drop the cached access token so the next call re-refreshes (401 recovery). */
  invalidateAccessToken(): void {
    this.memoryToken = undefined;
  }

  /** Best-effort revoke, then remove every stored gmail credential. */
  async disconnect(): Promise<void> {
    const refreshToken = this.store.getSecret('gmail.refreshToken');
    if (refreshToken) {
      try {
        await this.fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
      } catch {
        // Revoke is best-effort; local credentials are removed regardless.
      }
    }
    this.memoryToken = undefined;
    for (const key of ['gmail.refreshToken', 'gmail.email', 'gmail.needsReauth']) {
      this.store.delete(key);
    }
  }

  private rememberAccessToken(tokens: TokenResponse): void {
    if (!tokens.access_token) return;
    const ttlMs = Math.max((tokens.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS, 0);
    this.memoryToken = { token: tokens.access_token, expiresAt: Date.now() + ttlMs };
  }

  private async postToken(params: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    return await response.json() as TokenResponse;
  }

  private async fetchProfileEmail(accessToken: string): Promise<string> {
    const response = await this.fetchImpl(PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Gmail profile lookup failed (HTTP ${response.status})`);
    const profile = await response.json() as { emailAddress?: string };
    return profile.emailAddress ?? 'unknown';
  }

  /**
   * One-shot loopback server on an ephemeral 127.0.0.1 port. Resolves with the
   * authorization code after a state-validated callback; rejects on state
   * mismatch, consent denial, or timeout.
   */
  private startLoopbackServer(
    expectedState: string,
    onServer: (server: Server) => void,
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    return new Promise((resolveStart, rejectStart) => {
      let settleCode: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
      const codePromise = new Promise<string>((resolve, reject) => {
        settleCode = { resolve, reject };
      });

      const timeout = setTimeout(() => {
        settleCode?.reject(new Error('Timed out waiting for Google consent (2 minutes). Try connecting again.'));
      }, CONSENT_TIMEOUT_MS);
      timeout.unref?.();

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const finish = (body: string, err?: Error, code?: string) => {
          res.writeHead(err ? 400 : 200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:sans-serif"><p>${body}</p></body></html>`);
          clearTimeout(timeout);
          if (err) settleCode?.reject(err);
          else settleCode?.resolve(code as string);
        };

        const error = url.searchParams.get('error');
        if (error) {
          finish('OpenBoard: Gmail connection was denied. You can close this tab.', new Error(`Google consent denied: ${error}`));
          return;
        }
        if (url.searchParams.get('state') !== expectedState) {
          finish('OpenBoard: invalid OAuth state. You can close this tab.', new Error('OAuth state mismatch — aborting for safety.'));
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          finish('OpenBoard: no authorization code received. You can close this tab.', new Error('No authorization code in callback.'));
          return;
        }
        finish('OpenBoard connected to Gmail. You can close this tab and return to the terminal.', undefined, code);
      });

      server.on('error', (err) => rejectStart(err));
      server.listen(0, '127.0.0.1', () => {
        onServer(server);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          rejectStart(new Error('Failed to bind loopback server'));
          return;
        }
        resolveStart({ port: address.port, codePromise });
      });
    });
  }
}
