import { useEffect, useState } from 'react';
import type { ProtectedDashboardData } from './useProtectedDashboardData';

export interface AllDashboardsData<T = Record<string, unknown>> {
  dashboards: Record<string, ProtectedDashboardData<T>>;
  generatedAt?: string;
}

interface AllDataState<T> {
  data: AllDashboardsData<T> | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches the data of EVERY registered dashboard in one call — used by the
 * master/overview tab. Shell hook: synced from the template on every deploy.
 */
export function useAllDashboardsData<T = Record<string, unknown>>(): AllDataState<T> {
  const [state, setState] = useState<AllDataState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        setState((current) => ({ ...current, loading: true, error: null }));
        const response = await fetch('/api/dashboard-data?dashboard=__all__', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load dashboard data');
        }
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
  }, []);

  return state;
}
