import type { DashboardTabItem } from '../components/DashboardTabs';

export const dashboardTabs: DashboardTabItem[] = [];

export function renderDashboard(_id: string) {
  return <div className="card">Select a dashboard.</div>;
}
