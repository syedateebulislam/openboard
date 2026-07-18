/**
 * Phase 10 — Generated dashboard login rate limiter (security review finding #5).
 *
 * Exercises templates/dashboard/api/auth.ts directly. The limiter is
 * best-effort per serverless instance; these tests pin its observable
 * behavior: limit after MAX_ATTEMPTS in a window, recovery after the window,
 * per-IP isolation, and bounded memory (expired entries are pruned).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import handler from '../../templates/dashboard/api/auth.js';

interface MockResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  setHeader: (key: string, value: unknown) => void;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    setHeader(key: string, value: unknown) { res.headers[key] = value; },
  };
  return res;
}

function makeReq(ip: string, body?: { username?: string; password?: string }, method = 'POST') {
  return {
    method,
    headers: { 'x-forwarded-for': ip },
    body: body ?? { username: 'admin', password: 'wrong-password' },
  } as any;
}

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

describe('dashboard auth rate limiter', () => {
  beforeEach(() => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD_HASH_B64 = Buffer.from(bcrypt.hashSync('correct-password', 4)).toString('base64');
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD_HASH;
    delete process.env.DASHBOARD_PASSWORD_HASH_B64;
    delete process.env.JWT_SECRET;
  });

  it('rejects invalid credentials with 401', async () => {
    const res = makeRes();
    await handler(makeReq(uniqueIp()), res as any);
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid credentials and sets an httpOnly cookie', async () => {
    const res = makeRes();
    await handler(makeReq(uniqueIp(), { username: 'admin', password: 'correct-password' }), res as any);

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['Set-Cookie'])).toContain('auth_token=');
    expect(String(res.headers['Set-Cookie'])).toContain('HttpOnly');
  });

  it('returns 429 after more than 5 attempts inside the window', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq(ip), res as any);
      expect(res.statusCode).toBe(401);
    }

    const limited = makeRes();
    await handler(makeReq(ip), limited as any);
    expect(limited.statusCode).toBe(429);
  });

  it('does not rate limit other IPs', async () => {
    const noisy = uniqueIp();
    for (let i = 0; i < 6; i++) {
      await handler(makeReq(noisy), makeRes() as any);
    }

    const quiet = makeRes();
    await handler(makeReq(uniqueIp()), quiet as any);
    expect(quiet.statusCode).toBe(401);
  });

  it('allows attempts again after the window expires', async () => {
    vi.useFakeTimers();
    const ip = uniqueIp();
    for (let i = 0; i < 6; i++) {
      await handler(makeReq(ip), makeRes() as any);
    }
    const limited = makeRes();
    await handler(makeReq(ip), limited as any);
    expect(limited.statusCode).toBe(429);

    vi.advanceTimersByTime(61_000);

    const recovered = makeRes();
    await handler(makeReq(ip), recovered as any);
    expect(recovered.statusCode).toBe(401);
  });

  it('prunes expired entries so the attempt map stays bounded', async () => {
    vi.useFakeTimers();

    for (let i = 0; i < 50; i++) {
      await handler(makeReq(uniqueIp()), makeRes() as any);
    }
    vi.advanceTimersByTime(61_000);
    // Any request after the window should trigger pruning of all expired entries.
    await handler(makeReq(uniqueIp()), makeRes() as any);

    const { getRateLimiterSize } = await import('../../templates/dashboard/api/auth.js') as any;
    expect(typeof getRateLimiterSize).toBe('function');
    expect(getRateLimiterSize()).toBeLessThanOrEqual(2);
  });

  it('rejects requests without credentials with 400', async () => {
    const res = makeRes();
    await handler(makeReq(uniqueIp(), { username: '', password: '' }), res as any);
    expect(res.statusCode).toBe(400);
  });

  it('rejects unsupported methods with 405', async () => {
    const res = makeRes();
    await handler(makeReq(uniqueIp(), undefined, 'PUT'), res as any);
    expect(res.statusCode).toBe(405);
  });
});
