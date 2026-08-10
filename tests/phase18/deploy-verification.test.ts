/**
 * Post-deploy health check, and the false alarm it used to raise.
 *
 * Vercel Deployment Protection serves an SSO challenge to anyone
 * unauthenticated — as a 200 with a real HTML page. The app-root check saw a
 * page without `<div id="root">` and concluded the deployment was broken, so a
 * perfectly healthy deploy produced three "not healthy yet" lines and a
 * "Warning: deployed, but ..." on every single run. The check cannot see past
 * an auth wall; the fix is to say so rather than to guess.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DeployVerificationService,
  isProtectionChallenge,
} from '../../src/services/deploy/DeployVerificationService.js';

const APP_URL = 'https://openboard-workspace-abc123.vercel.app';

/** A Response stand-in with only the fields the checker reads. */
function reply(options: { status?: number; url?: string; body?: string; json?: unknown }): any {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? APP_URL,
    text: async () => options.body ?? '',
    json: async () => options.json ?? {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recognising an auth wall', () => {
  it('spots the SSO nonce Vercel puts in the challenge page', () => {
    expect(isProtectionChallenge(reply({}), '<html>_vercel_sso_nonce</html>')).toBe(true);
  });

  it('spots a redirect that landed on vercel.com', () => {
    expect(isProtectionChallenge(reply({ url: 'https://vercel.com/sso-api?url=x' }), '<html></html>')).toBe(true);
  });

  it('treats 401 as protection, whatever the body says', () => {
    expect(isProtectionChallenge(reply({ status: 401 }), '')).toBe(true);
  });

  it('does not mistake the real app for a challenge', () => {
    expect(isProtectionChallenge(reply({}), '<html><div id="root"></div></html>')).toBe(false);
  });
});

describe('verifying a deployment', () => {
  it('reports protection instead of failure, and does not retry', async () => {
    const fetchMock = vi.fn(async () => reply({ body: '<html>_vercel_sso_nonce</html>' }));
    vi.stubGlobal('fetch', fetchMock);
    const lines: string[] = [];

    const result = await DeployVerificationService.verify(APP_URL, (line) => lines.push(line));

    expect(result.success).toBe(false);
    expect(result.protected).toBe(true);
    // The point of the fix: one attempt, not three rounds of "not healthy yet"
    // against a wall that will answer identically every time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/protected by Vercel Authentication/i);
    expect(lines.join('\n')).not.toMatch(/not healthy yet/i);
  });

  it('still fails a genuinely broken deployment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ body: '<html>nothing here</html>' })));

    const result = await DeployVerificationService.verify(APP_URL, () => {}, 0);

    expect(result.success).toBe(false);
    expect(result.protected).toBeFalsy();
    expect(result.error).toMatch(/without the app root element/i);
  });

  it('passes a healthy deployment', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/api/auth')
        ? reply({ status: 401, json: { error: 'unauthenticated' } })
        : reply({ body: '<html><div id="root"></div></html>' })
    )));

    const result = await DeployVerificationService.verify(APP_URL, () => {});

    expect(result.success).toBe(true);
    expect(result.protected).toBeFalsy();
  });
});
