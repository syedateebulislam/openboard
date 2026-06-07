import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

export interface AuthenticatedUser {
  username: string;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  return cookieHeader?.split(';').reduce((acc: Record<string, string>, cookie: string) => {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rawValue.join('='));
    return acc;
  }, {}) || {};
}

export function buildAuthCookie(token: string, maxAgeSeconds: number): string {
  return [
    `auth_token=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearAuthCookie(): string {
  return 'auth_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}

export function verifyAuth(req: VercelRequest): AuthenticatedUser | null {
  const token = parseCookies(req.headers.cookie).auth_token;
  const jwtSecret = process.env.JWT_SECRET;
  if (!token || !jwtSecret) return null;

  try {
    const decoded = jwt.verify(token, jwtSecret) as { username?: string };
    if (!decoded.username) return null;
    return { username: decoded.username };
  } catch {
    return null;
  }
}

export function requireAuth(req: VercelRequest, res: VercelResponse): AuthenticatedUser | null {
  const user = verifyAuth(req);
  if (!user) {
    res.status(401).json({ authenticated: false, error: 'Authentication required' });
    return null;
  }
  return user;
}
