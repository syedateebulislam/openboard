import { useState, FormEvent } from 'react';
import { useAuth } from './AuthProvider';
import { BrandLogo } from './BrandLogo';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Important: include cookies
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      // Token is now in httpOnly cookie, just pass username
      login(data.username);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-header-side" />
        <div className="app-brand">
          <BrandLogo />
          <h1 className="app-title">OpenBoard</h1>
        </div>
        <div className="app-header-side" />
      </header>

      <main className="login-main" role="main" aria-label="Login form">
        <div className="card login-card">
          <h2 className="login-heading">Welcome back</h2>
          <p className="login-subtitle">Sign in to view your dashboards</p>

          <form onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="username" className="login-label">Username</label>
              <input
                id="username"
                className="input-field"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
                autoComplete="username"
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            <div className="login-field">
              <label htmlFor="password" className="login-label">Password</label>
              <input
                id="password"
                className="input-field"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            {error && <p id="login-error" role="alert" className="login-error">{error}</p>}
            <button
              type="submit"
              className="btn-primary login-submit"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
