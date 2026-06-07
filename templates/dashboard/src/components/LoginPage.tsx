import { useState, FormEvent } from 'react';
import { useAuth } from './AuthProvider';

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' }}>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px' }} role="main" aria-label="Login form">
        <h1 style={{ color: '#e8e8f0', marginBottom: '1.5rem', textAlign: 'center' }}>📊 Dashboard Login</h1>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="username" style={{ display: 'block', color: '#9090a0', marginBottom: '0.5rem' }}>Username</label>
            <input
              id="username"
              type="text" 
              value={username} 
              onChange={e => setUsername(e.target.value)}
              style={{ width: '100%', padding: '0.75rem', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: '6px', color: '#e8e8f0' }}
              required 
              autoFocus
              autoComplete="username"
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="password" style={{ display: 'block', color: '#9090a0', marginBottom: '0.5rem' }}>Password</label>
            <input
              id="password"
              type="password" 
              value={password} 
              onChange={e => setPassword(e.target.value)}
              style={{ width: '100%', padding: '0.75rem', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: '6px', color: '#e8e8f0' }}
              required
              autoComplete="current-password"
            />
          </div>
          {error && <p id="login-error" role="alert" style={{ color: '#ef4444', marginBottom: '1rem', textAlign: 'center' }}>{error}</p>}
          <button
            type="submit" 
            disabled={loading}
            style={{ width: '100%', padding: '0.75rem', background: '#7c3aed', border: 'none', borderRadius: '6px', color: '#fff', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer' }}
            aria-busy={loading}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
