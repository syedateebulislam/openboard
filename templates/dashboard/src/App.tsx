import './App.css'
import { useState } from 'react'
import { AuthProvider, useAuth } from './components/AuthProvider'
import { BrandLogo } from './components/BrandLogo'
import { LoginPage } from './components/LoginPage'
import { ThemeToggle } from './components/ThemeToggle'
import { DashboardTabs } from './components/DashboardTabs'
import type { DashboardTabItem } from './components/DashboardTabs'

function DashboardContent() {
  const { isAuthenticated, user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('welcome');

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const tabs: DashboardTabItem[] = [{ id: 'welcome', label: 'Welcome' }];

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-header-side" />
        <div className="app-brand">
          <BrandLogo />
          <h1 className="app-title">OpenBoard</h1>
        </div>
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
          <div className="card kpi-card">
            <p className="kpi-label">Welcome</p>
            <p className="kpi-value">Dashboard Ready</p>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              Your OpenBoard master UI is ready. Add dashboards as tabs from OpenBoard.
            </p>
          </div>
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
