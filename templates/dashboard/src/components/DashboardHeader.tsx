import { Clock, Database } from 'lucide-react';
import { format, isValid, parseISO } from 'date-fns';

/**
 * Consistent header strip rendered at the top of every dashboard tab:
 * the dashboard title on the left, and on the right the total rows fetched
 * plus when the data/UI was last generated — so the user always sees how
 * fresh the dashboard is. Feed it from the protected data hook:
 *   <DashboardHeader title="Swiggy Food" rowCount={data?.rows.length} generatedAt={data?.generatedAt} />
 *
 * Theme-aware (design-system variables only) and safe for any data: missing
 * rowCount or an unparseable timestamp degrade gracefully and never throw.
 */
export interface DashboardHeaderProps {
  title: string;
  /** Total rows the protected hook returned (data?.rows.length). */
  rowCount?: number;
  /** ISO timestamp of the last data/UI generation (data?.generatedAt). */
  generatedAt?: string;
}

function formatTimestamp(generatedAt?: string): { label: string; iso?: string } {
  if (!generatedAt) return { label: 'Unknown' };
  const parsed = parseISO(generatedAt);
  if (!isValid(parsed)) return { label: 'Unknown' };
  return { label: format(parsed, 'MMM d, yyyy · h:mm a'), iso: parsed.toISOString() };
}

export function DashboardHeader({ title, rowCount, generatedAt }: DashboardHeaderProps) {
  const rows = typeof rowCount === 'number' && Number.isFinite(rowCount) ? rowCount : undefined;
  const updated = formatTimestamp(generatedAt);

  return (
    <header className="dashboard-header">
      <h2 className="dashboard-header-title">{title}</h2>
      <div className="dashboard-header-meta">
        <span className="dashboard-meta-item" title="Total rows fetched for this dashboard">
          <Database size={14} aria-hidden="true" />
          <span>{rows !== undefined ? `${rows.toLocaleString()} rows` : 'No data'}</span>
        </span>
        <span className="dashboard-meta-item" title={updated.iso ? `Last updated ${updated.iso}` : 'Last updated time unavailable'}>
          <Clock size={14} aria-hidden="true" />
          <span>Updated {updated.label}</span>
        </span>
      </div>
    </header>
  );
}

export default DashboardHeader;
