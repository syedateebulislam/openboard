import './App.css'
import { useEffect, useState } from 'react'
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
  const tabs: DashboardTabItem[] = dashboardTabs.length > 0
    ? dashboardTabs
    : [{ id: 'welcome', label: 'Welcome' }];
  const [activeTab, setActiveTab] = useState(() => tabs[0].id);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0].id);
  }, [activeTab, tabs]);

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app-container">
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
          <h1 className="app-title">OpenBoard</h1>
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
      <main className="app-content">
        <DashboardTabs tabs={tabs} activeId={activeTab} onSelect={setActiveTab} />
        <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
          {dashboardTabs.length === 0 ? <div className="card kpi-card">
            <p className="kpi-label">Welcome</p>
            <p className="kpi-value">Dashboard Ready</p>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              Your OpenBoard master UI is ready. Add dashboards as tabs from OpenBoard.
            </p>
          </div> : (
            <ErrorBoundary key={activeTab} tabLabel={tabs.find((tab) => tab.id === activeTab)?.label}>
              {renderDashboard(activeTab)}
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
