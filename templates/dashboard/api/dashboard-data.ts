import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './_auth';
import { PROTECTED_DASHBOARD_DATA } from './_data/protected-data';

const DASHBOARD_NAME = /^[a-z0-9-]+$/;

function validateDashboardName(name: string): string {
  if (!DASHBOARD_NAME.test(name)) {
    throw new Error('Invalid dashboard name');
  }
  return name;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const dashboard = String(req.query.dashboard || '').trim();
  if (!dashboard) {
    return res.status(400).json({ error: 'Missing dashboard query parameter' });
  }

  try {
    const safeDashboard = validateDashboardName(dashboard);
    const data = (PROTECTED_DASHBOARD_DATA as Record<string, unknown>)[safeDashboard];
    if (!data) {
      return res.status(404).json({ error: 'Dashboard data not found' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load dashboard data';
    return res.status(400).json({ error: message });
  }
}
