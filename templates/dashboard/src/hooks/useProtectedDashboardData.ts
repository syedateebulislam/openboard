import { useEffect, useState } from 'react';

export interface ProtectedDashboardData<T = Record<string, unknown>> {
  rows: T[];
  headers?: string[];
  summary?: string;
  generatedAt?: string;
}

interface DataState<T> {
  data: ProtectedDashboardData<T> | null;
  loading: boolean;
  error: string | null;
}

/**
 * Payloads already fetched this page load, keyed by dashboard name.
 *
 * The endpoint sends `Cache-Control: private, no-store`, which is right for
 * data behind a login but means the browser keeps nothing: switching to a tab
 * and back re-downloaded and re-parsed the identical JSON every time. The data
 * is a static build artifact — it cannot change without a redeploy, which
 * reloads the page — so holding it for the life of the page is safe.
 *
 * In-flight requests are cached too, so two components mounting against the
 * same dashboard in one render issue one request rather than two.
 */
const dashboardCache = new Map<string, Promise<unknown>>();

function fetchDashboard(dashboard: string): Promise<unknown> {
  const cached = dashboardCache.get(dashboard);
  if (cached) return cached;

  const request = (async () => {
    const response = await fetch(`/api/dashboard-data?dashboard=${encodeURIComponent(dashboard)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load dashboard data');
    }
    return payload;
  })();

  // A failed request must not be cached, or one dropped connection leaves the
  // tab permanently broken with no way to retry but a reload.
  request.catch(() => dashboardCache.delete(dashboard));
  dashboardCache.set(dashboard, request);
  return request;
}

export function useProtectedDashboardData<T = Record<string, unknown>>(dashboard: string): DataState<T> {
  const [state, setState] = useState<DataState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        setState((current) => ({ ...current, loading: true, error: null }));
        const payload = (await fetchDashboard(dashboard)) as ProtectedDashboardData<T>;
        if (!cancelled) {
          setState({ data: payload, loading: false, error: null });
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : 'Failed to load dashboard data',
          });
        }
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [dashboard]);

  return state;
}
