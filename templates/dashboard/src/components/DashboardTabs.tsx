import { useEffect, useState } from 'react';

export interface DashboardTabItem {
  id: string;
  label: string;
}

interface DashboardTabsProps {
  tabs: DashboardTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * OpenBoard dashboard navigation.
 *
 * Desktop: a frosted liquid-glass pill bar (role="tablist").
 * Mobile: collapses behind a navbar toggler that drops the tabs down as a
 * glass menu — a responsive Navbar/Collapse pattern.
 *
 * Product-owned shell component — refreshed from the template on every deploy.
 * Do NOT inline a per-dashboard tab bar; render this component instead. Each
 * tab button keeps id="tab-<id>" and aria-controls="panel-<id>" so the panel
 * App.tsx renders below stays correctly associated.
 */
export function DashboardTabs({ tabs, activeId, onSelect }: DashboardTabsProps) {
  const [open, setOpen] = useState(false);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  // Auto-close the mobile menu when the viewport widens to desktop.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 641px)');
    const sync = () => {
      if (mq.matches) setOpen(false);
    };
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);

  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <nav className={`app-tabs${open ? ' open' : ''}`} aria-label="OpenBoard dashboards">
      <button
        type="button"
        className="tabs-toggler"
        aria-expanded={open}
        aria-controls="dashboard-tablist"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="tabs-toggler-label">{active?.label ?? 'Dashboards'}</span>
        <span className="tabs-toggler-icon" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="sr-only">Toggle dashboard menu</span>
      </button>

      <div
        className="tabs-list"
        id="dashboard-tablist"
        role="tablist"
        aria-label="OpenBoard dashboards"
      >
        {tabs.map((tab) => {
          const selected = active?.id === tab.id;
          return (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`tab-btn${selected ? ' active' : ''}`}
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
