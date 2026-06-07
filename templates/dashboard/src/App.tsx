import './App.css'
import { AuthProvider, useAuth } from './components/AuthProvider'
import { LoginPage } from './components/LoginPage'

function DashboardContent() {
  const { isAuthenticated, user, logout } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-header-side" />
        <h1 className="app-title">OpenBoard</h1>
        <div className="app-header-side" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '1rem' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {user?.username}
          </span>
          <button
            onClick={logout}
            style={{
              background: 'transparent',
              border: '1px solid #1e1e2e',
              color: '#9090a0',
              padding: '0.375rem 0.75rem',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
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
        <div className="card">
          <p className="card-title">Welcome</p>
          <p className="metric-value">Dashboard Ready</p>
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
