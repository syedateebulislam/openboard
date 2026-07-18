import type { VercelRequest, VercelResponse } from '@vercel/node';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { buildAuthCookie, clearAuthCookie, verifyAuth } from './_auth.js';

// Best-effort in-memory rate limiter.
//
// LIMITATION (serverless): every Vercel instance and cold start has its own
// independent Map, so the cap applies per instance, not globally. It still
// slows down single-instance brute force, which is the realistic path for a
// single-user dashboard. For a durable global limit, back this with Vercel
// KV/Upstash or move auth to an identity provider.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_TRACKED_KEYS = 5000; // hard memory bound under IP-spray attacks

function getRateLimitKey(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0] || 'unknown';
  return ip.trim();
}

function pruneExpired(now: number): void {
  for (const [key, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(key);
  }
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  pruneExpired(now);

  if (loginAttempts.size >= MAX_TRACKED_KEYS && !loginAttempts.has(key)) {
    // Evict the oldest live entry so the map stays bounded.
    const oldest = loginAttempts.keys().next().value;
    if (oldest !== undefined) loginAttempts.delete(oldest);
  }

  const record = loginAttempts.get(key);
  if (!record) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  record.count++;
  return record.count > MAX_ATTEMPTS;
}

/** Test-only introspection: number of tracked rate-limit entries. */
export function getRateLimiterSize(): number {
  return loginAttempts.size;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle logout
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearAuthCookie());
    return res.status(200).json({ success: true });
  }

  // Handle token verification
  if (req.method === 'GET') {
    const user = verifyAuth(req);
    if (!user) return res.status(401).json({ authenticated: false });
    return res.status(200).json({ authenticated: true, username: user.username });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting check
  const rateLimitKey = getRateLimitKey(req);
  if (isRateLimited(rateLimitKey)) {
    return res.status(429).json({ 
      error: 'Too many login attempts. Please try again in a minute.' 
    });
  }

  const { username, password } = req.body as { username: string; password: string };

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const storedUsername = process.env.DASHBOARD_USERNAME;
  // Base64 prevents bcrypt's '$' characters being changed by dotenv/shell
  // expansion. Keep the raw variable as a migration fallback.
  const passwordHash = process.env.DASHBOARD_PASSWORD_HASH_B64
    ? Buffer.from(process.env.DASHBOARD_PASSWORD_HASH_B64, 'base64').toString('utf-8')
    : process.env.DASHBOARD_PASSWORD_HASH;
  const jwtSecret = process.env.JWT_SECRET;

  if (!storedUsername || !passwordHash || !jwtSecret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (username !== storedUsername) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const isValid = await bcrypt.compare(password, passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username }, jwtSecret, { expiresIn: '7d' });
  
  // Set httpOnly cookie instead of returning token in body
  const maxAge = 7 * 24 * 60 * 60; // 7 days in seconds
  res.setHeader('Set-Cookie', buildAuthCookie(token, maxAge));
  
  return res.status(200).json({ success: true, username });
}
