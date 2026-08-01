/**
 * Phase 15 — security review fixes for the generated dashboard login.
 *
 * Two findings are pinned here:
 *
 *  - Username enumeration. The handler used to return 401 immediately when the
 *    username was unknown and only run bcrypt for a known one, so the ~240ms
 *    cost difference told an attacker which usernames exist. Both paths must
 *    now perform a comparison.
 *  - Rate-limit key. The bucket was keyed on the leftmost x-forwarded-for
 *    entry, which the client controls, so rotating that header minted a fresh
 *    5-attempt allowance per request. It must key on something the edge sets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import handler from '../../templates/dashboard/api/auth.js';

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    setHeader(key: string, value: unknown) { res.headers[key] = value; },
  };
  return res;
}

let ipCounter = 0;
/** Distinct per call: the limiter's Map is module state shared across tests. */
function uniqueIp(): string {
  ipCounter += 1;
  return `172.16.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

describe('dashboard login hardening', () => {
  beforeEach(() => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD_HASH_B64 =
      Buffer.from(bcrypt.hashSync('correct-password', 4)).toString('base64');
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD_HASH_B64;
    delete process.env.JWT_SECRET;
  });

  describe('username enumeration', () => {
    it('still runs a bcrypt comparison when the username is unknown', async () => {
      const compare = vi.spyOn(bcrypt, 'compare');
      const res = makeRes();
      await handler(
        {
          method: 'POST',
          headers: { 'x-real-ip': uniqueIp() },
          body: { username: 'no-such-user', password: 'whatever' },
        } as any,
        res as any,
      );

      expect(res.statusCode).toBe(401);
      // The point of the fix: work is done even though the name is unknown.
      expect(compare).toHaveBeenCalledTimes(1);
    });

    it('compares against a real cost-12 hash, not the configured one', async () => {
      const compare = vi.spyOn(bcrypt, 'compare');
      await handler(
        {
          method: 'POST',
          headers: { 'x-real-ip': uniqueIp() },
          body: { username: 'no-such-user', password: 'whatever' },
        } as any,
        makeRes() as any,
      );

      const [, hashUsed] = compare.mock.calls[0] as [string, string];
      // A malformed placeholder would make bcrypt return early and reopen the
      // timing gap, so assert it is a genuine cost-12 hash.
      expect(hashUsed).toMatch(/^\$2[aby]\$12\$/);
      expect(hashUsed).not.toBe(
        Buffer.from(process.env.DASHBOARD_PASSWORD_HASH_B64!, 'base64').toString('utf-8'),
      );
    });

    it('gives the same status and message for unknown and known usernames', async () => {
      const unknownRes = makeRes();
      await handler(
        { method: 'POST', headers: { 'x-real-ip': uniqueIp() }, body: { username: 'nobody', password: 'x' } } as any,
        unknownRes as any,
      );
      const knownRes = makeRes();
      await handler(
        { method: 'POST', headers: { 'x-real-ip': uniqueIp() }, body: { username: 'admin', password: 'x' } } as any,
        knownRes as any,
      );

      expect(unknownRes.statusCode).toBe(knownRes.statusCode);
      expect(unknownRes.body).toEqual(knownRes.body);
    });
  });

  describe('rate-limit key', () => {
    it('cannot be reset by rotating a client-supplied x-forwarded-for', async () => {
      const edgeIp = uniqueIp();
      let lastStatus = 0;

      // Six attempts from one real peer, each claiming a different origin in
      // the header the client can write. Pre-fix these were six separate
      // buckets and none of them ever tripped.
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = makeRes();
        await handler(
          {
            method: 'POST',
            headers: { 'x-forwarded-for': `10.1.1.${attempt}, ${edgeIp}` },
            body: { username: 'admin', password: 'wrong' },
          } as any,
          res as any,
        );
        lastStatus = res.statusCode;
      }

      expect(lastStatus).toBe(429);
    });

    it('prefers x-real-ip over the forwarded chain', async () => {
      const realIp = uniqueIp();
      let lastStatus = 0;

      for (let attempt = 0; attempt < 6; attempt++) {
        const res = makeRes();
        await handler(
          {
            method: 'POST',
            headers: { 'x-real-ip': realIp, 'x-forwarded-for': `10.2.2.${attempt}` },
            body: { username: 'admin', password: 'wrong' },
          } as any,
          res as any,
        );
        lastStatus = res.statusCode;
      }

      expect(lastStatus).toBe(429);
    });

    it('keeps genuinely different peers in separate buckets', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await handler(
          {
            method: 'POST',
            headers: { 'x-real-ip': uniqueIp() },
            body: { username: 'admin', password: 'wrong' },
          } as any,
          makeRes() as any,
        );
      }

      const fresh = makeRes();
      await handler(
        { method: 'POST', headers: { 'x-real-ip': uniqueIp() }, body: { username: 'admin', password: 'wrong' } } as any,
        fresh as any,
      );
      expect(fresh.statusCode).toBe(401);
    });
  });
});
