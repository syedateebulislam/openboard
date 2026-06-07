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
        const response = await fetch(`/api/dashboard-data?dashboard=${encodeURIComponent(dashboard)}`, {
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
  }, [dashboard]);

  return state;
}
