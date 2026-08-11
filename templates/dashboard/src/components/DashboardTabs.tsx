// Aliased: the outside-click effect below types its listener against the DOM's
// global KeyboardEvent, and an unaliased import would shadow it.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface DashboardTabItem {
  id: string;
  label: string;
  /**
   * Optional category (e.g. "Finance", "Transport", "Food & Dining"). Tabs
   * that share a group collapse behind one dropdown on desktop so many
   * dashboards fit on screen. Tabs without a group render as plain pills.
   */
  group?: string;
}

interface DashboardTabsProps {
  tabs: DashboardTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * OpenBoardCLI dashboard navigation.
 *
 * Desktop: a frosted liquid-glass pill bar. Ungrouped tabs render as pills;
 * tabs that carry a `group` collapse into one glass dropdown per category
 * (Finance, Transport, …) so the bar scales to many dashboards.
 * Mobile: collapses behind a navbar toggler that drops the tabs down as a
 * glass menu, with group section headers — a responsive Navbar/Collapse
 * pattern.
 *
 * Semantics: with no groups this is a strict tablist/tab pattern. With
 * groups it becomes a disclosure navigation (aria-haspopup menus +
 * aria-current on the active dashboard), because ARIA forbids non-tab
 * children inside a tablist. Every button keeps id="tab-<id>" and
 * aria-controls="panel-<id>" either way, so the panel App.tsx renders below
 * stays correctly associated.
 *
 * Product-owned shell component — refreshed from the template on every deploy.
 * Do NOT inline a per-dashboard tab bar; render this component instead.
 */
export function DashboardTabs({ tabs, activeId, onSelect }: DashboardTabsProps) {
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
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

  // Close an open category dropdown on outside click or Escape.
  useEffect(() => {
    if (!openGroup) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && navRef.current && !navRef.current.contains(target)) {
        setOpenGroup(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenGroup(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openGroup]);

  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
    setOpenGroup(null);
  };

  /**
   * Arrow-key movement across the tablist, per the ARIA tabs pattern.
   *
   * The roving tabIndex below is only half of that pattern, and half of it is
   * worse than none: every unselected tab carries tabIndex={-1}, so Tab skips
   * them, and without this handler there was no other way in. A keyboard user
   * could not change dashboards at all — WCAG 2.2 SC 2.1.1.
   *
   * Selection follows focus, which is the expected behaviour for tabs whose
   * panels are already loaded.
   */
  const onTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const current = tabs.findIndex((tab) => tab.id === active?.id);
    if (current === -1) return;

    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;

    const target = tabs[next];
    if (!target) return;
    select(target.id);
    // Move real focus too — otherwise the next arrow press is still handled by
    // the old element and the focus ring lags a tab behind the selection.
    document.getElementById(`tab-${target.id}`)?.focus();
  };

  // Disclosure-nav variant used in grouped mode (inside dropdowns and the
  // mobile menu), where a tablist ancestor is not allowed.
  const renderNavButton = (tab: DashboardTabItem) => {
    const selected = active?.id === tab.id;
    return (
      <button
        key={tab.id}
        id={`tab-${tab.id}`}
        type="button"
        aria-current={selected ? 'page' : undefined}
        aria-controls={`panel-${tab.id}`}
        className={`tab-btn${selected ? ' active' : ''}`}
        onClick={() => select(tab.id)}
      >
        {tab.label}
      </button>
    );
  };

  // Group tabs by category, preserving first-appearance order. Entries are
  // either a run of ungrouped tabs or a named group of tabs.
  type NavEntry = { group: string | null; tabs: DashboardTabItem[] };
  const entries: NavEntry[] = [];
  for (const tab of tabs) {
    const group = tab.group?.trim() || null;
    const existing = group ? entries.find((entry) => entry.group === group) : undefined;
    if (existing) {
      existing.tabs.push(tab);
    } else {
      entries.push({ group, tabs: [tab] });
    }
  }
  const hasGroups = entries.some((entry) => entry.group !== null);

  return (
    <nav ref={navRef} className={`app-tabs${open ? ' open' : ''}`} aria-label="OpenBoardCLI dashboards">
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

      {!hasGroups && (
        <div
          className="tabs-list"
          id="dashboard-tablist"
          role="tablist"
          aria-label="OpenBoardCLI dashboards"
          onKeyDown={onTablistKeyDown}
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
      )}

      {hasGroups && (
        <div className={`tabs-list${openGroup ? ' group-open' : ''}`} id="dashboard-tablist">
          {/* Desktop: pills + one dropdown per category. On mobile the same
              markup flows vertically inside the collapse, so dropdowns are
              replaced by section headers below. */}
          {entries.map((entry, index) => {
            if (!entry.group) {
              return entry.tabs.map(renderNavButton);
            }
            const groupActive = entry.tabs.some((tab) => tab.id === active?.id);
            const expanded = openGroup === entry.group;
            return (
              <div key={entry.group ?? index} className={`tab-group${expanded ? ' open' : ''}`}>
                <button
                  type="button"
                  className={`tab-group-btn${groupActive ? ' active' : ''}`}
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  onClick={() => setOpenGroup((prev) => (prev === entry.group ? null : entry.group))}
                >
                  {entry.group}
                  <span className="tab-group-caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {expanded && <div className="tab-group-menu">{entry.tabs.map(renderNavButton)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}
