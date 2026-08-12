import './App.css'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './components/AuthProvider'
import { BrandLogo } from './components/BrandLogo'
import { LoginPage } from './components/LoginPage'
import { ThemeToggle } from './components/ThemeToggle'
import { DashboardTabs } from './components/DashboardTabs'
import type { DashboardTabItem } from './components/DashboardTabs'
import { HeaderLinks } from './components/HeaderLinks'
import { ErrorBoundary } from './components/ErrorBoundary'
import { dashboardTabs, renderDashboard } from './generated/dashboardManifest'

function DashboardContent() {
  const { isAuthenticated, user, logout } = useAuth();
  // Memoized because it is a useEffect dependency below. The fallback branch
  // built a fresh array literal on every render, so the effect re-ran every
  // render whenever there were no dashboards.
  const tabs: DashboardTabItem[] = useMemo(
    () => (dashboardTabs.length > 0 ? dashboardTabs : [{ id: 'welcome', label: 'Welcome' }]),
    [],
  );
  const [activeTab, setActiveTab] = useState(() => tabs[0].id);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0].id);
  }, [activeTab, tabs]);

  const activeLabel = tabs.find((tab) => tab.id === activeTab)?.label;

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app-container">
      {/* First focusable thing on the page: lets a keyboard user reach the
          dashboard without tabbing through the header links every time. */}
      <a className="skip-link" href="#dashboard-panel">
        Skip to dashboard
      </a>
      {/*
        The page's only h1. It is sr-only because the visible wordmark lives
        inside the brand button, and a heading nested in a button is not
        reachable as a heading — screen-reader users had no h1 to navigate to
        and no statement of what the page is. Kept outside the header so the
        header's grid layout is untouched.
      */}
      <h1 className="sr-only">OpenBoardCLI dashboards</h1>
      <header className="app-header">
        <div className="app-header-side">
          <HeaderLinks />
        </div>
        <button
          type="button"
          className="app-brand"
          onClick={() => setActiveTab(tabs[0].id)}
          aria-label="Go to home tab"
        >
          <BrandLogo />
          <span className="app-title-text">OpenBoardCLI</span>
        </button>
        <div className="app-header-side app-header-actions">
          <span className="app-greeting">
            Hi, <strong>{user?.username}</strong>
          </span>
          <ThemeToggle />
          <button type="button" className="btn-ghost" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      {/* tabIndex={-1} so the skip link above can actually move focus here;
          the panel's own id changes with the tab, so the stable anchor is the
          landmark rather than the panel. */}
      <main className="app-content" id="dashboard-panel" tabIndex={-1}>
        <DashboardTabs tabs={tabs} activeId={activeTab} onSelect={setActiveTab} />
        {/* Tab changes are a visual-only event otherwise: the panel swaps its
            entire contents with nothing announced. Polite so it waits for the
            user to finish what they are reading. */}
        <div className="sr-only" role="status" aria-live="polite">
          {activeLabel ? `${activeLabel} dashboard shown` : ''}
        </div>
        {/*
          tabIndex={0} makes the panel itself a tab stop. Without it, a panel
          whose content has no focusable element (a chart, a table of numbers)
          cannot be reached by keyboard at all, so its content is unreadable to
          anyone navigating that way. Required by the ARIA tabs pattern.
        */}
        <div
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
          tabIndex={0}
        >
          {dashboardTabs.length === 0 ? <div className="card kpi-card">
            <p className="kpi-label">Welcome</p>
            <p className="kpi-value">Dashboard Ready</p>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              Your OpenBoardCLI master UI is ready. Add dashboards as tabs from OpenBoardCLI.
            </p>
          </div> : (
            <ErrorBoundary key={activeTab} tabLabel={activeLabel}>
              {/* The manifest loads each dashboard with React.lazy so only the
                  open tab's code is fetched, which needs a Suspense boundary
                  above it. The fallback announces itself: a tab swap that
                  briefly shows nothing is otherwise silent. */}
              <Suspense
                fallback={
                  <div className="card" role="status" aria-live="polite">
                    Loading {activeLabel ?? 'dashboard'}…
                  </div>
                }
              >
                {renderDashboard(activeTab)}
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </main>
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <DashboardContent />
    </AuthProvider>
  )
}

export default App
