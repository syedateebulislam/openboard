/**
 * Phase 12 — Gmail integration: REST client pagination and retry behavior.
 */

import { describe, it, expect } from 'vitest';
import { GmailClient } from '../../src/services/mail/GmailClient.js';
import { GmailReauthRequiredError } from '../../src/services/mail/GmailAuthService.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clientWith(handler: (url: string, call: number) => Response | Promise<Response>, hooks: {
  onInvalidate?: () => void;
} = {}) {
  let calls = 0;
  const urls: string[] = [];
  const client = new GmailClient({
    getAccessToken: async () => 'token',
    invalidateAccessToken: hooks.onInvalidate,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return handler(url, calls++);
    }) as typeof fetch,
    delayImpl: async () => {},
  });
  return { client, urls };
}

describe('GmailClient', () => {
  it('paginates listMessages up to maxResults', async () => {
    const { client, urls } = clientWith((url) => {
      if (!url.includes('pageToken')) {
        return jsonResponse({
          messages: [{ id: 'a', threadId: 'ta' }, { id: 'b', threadId: 'tb' }],
          nextPageToken: 'page2',
        });
      }
      return jsonResponse({ messages: [{ id: 'c', threadId: 'tc' }] });
    });

    const refs = await client.listMessages('in:inbox', 3);
    expect(refs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(urls[0]).toContain('q=in%3Ainbox');
    expect(urls[1]).toContain('pageToken=page2');
  });

  it('retries once on 401 after invalidating the cached token', async () => {
    let invalidated = 0;
    const { client } = clientWith(
      (_url, call) => call === 0
        ? jsonResponse({}, 401)
        : jsonResponse({ id: 'm1', threadId: 't1' }),
      { onInvalidate: () => { invalidated += 1; } },
    );

    const message = await client.getMessage('m1');
    expect(message.id).toBe('m1');
    expect(invalidated).toBe(1);
  });

  it('throws GmailReauthRequiredError on a second consecutive 401', async () => {
    const { client } = clientWith(() => jsonResponse({}, 401));
    await expect(client.getMessage('m1')).rejects.toBeInstanceOf(GmailReauthRequiredError);
  });

  it('retries once on 500 then surfaces the error', async () => {
    let attempts = 0;
    const { client } = clientWith(() => {
      attempts += 1;
      return jsonResponse({ error: 'boom' }, 500);
    });

    await expect(client.getProfile()).rejects.toThrow(/HTTP 500/);
    expect(attempts).toBe(2);
  });

  it('fetches message batches preserving order', async () => {
    const { client } = clientWith((url) => {
      const id = url.match(/messages\/([^?]+)/)?.[1] ?? '';
      return jsonResponse({ id, threadId: `t-${id}` });
    });

    const refs = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, threadId: `t-m${i}` }));
    const messages = await client.getMessages(refs);
    expect(messages.map((m) => m.id)).toEqual(refs.map((r) => r.id));
  });
});
