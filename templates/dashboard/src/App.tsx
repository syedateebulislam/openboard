import './App.css'
import { AuthProvider, useAuth } from './components/AuthProvider'
import { BrandLogo } from './components/BrandLogo'
import { LoginPage } from './components/LoginPage'
import { ThemeToggle } from './components/ThemeToggle'

function DashboardContent() {
  const { isAuthenticated, user, logout } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-header-side" />
        <div className="app-brand">
          <BrandLogo />
          <h1 className="app-title">OpenBoard</h1>
        </div>
        <div className="app-header-side" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {user?.username}
          </span>
          <ThemeToggle />
          <button type="button" className="btn-ghost" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      <nav className="app-tabs" role="tablist" aria-label="Dashboard tabs">
        <button type="button" className="tab-btn active" role="tab" aria-selected="true" aria-controls="panel-welcome" id="tab-welcome">
          Welcome
        </button>
      </nav>
      <main className="app-content" role="tabpanel" id="panel-welcome" aria-labelledby="tab-welcome">
        <div className="card kpi-card">
          <p className="kpi-label">Welcome</p>
          <p className="kpi-value">Dashboard Ready</p>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Your OpenBoard master UI is ready. Add dashboards as tabs from OpenBoard.
          </p>
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
