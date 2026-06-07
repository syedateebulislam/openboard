import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import type { AuthContextType, AuthUser } from '../types/auth';

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Check authentication status on mount (token is in httpOnly cookie)
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth', { method: 'GET', credentials: 'include' });
        const data = await res.json();
        if (data.authenticated && data.username) {
          setUser({ username: data.username });
        }
        // Not authenticated — user stays null, LoginPage will show
      } catch {
        // API unreachable: keep user unauthenticated. Auth must always be server-decided.
      } finally {
        setLoading(false);
      }
    }
    checkAuth();
  }, []);

  const login = useCallback((username: string) => {
    // Token is now set as httpOnly cookie by the server
    // We just track the username for display purposes
    setUser({ username });
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth', { method: 'DELETE', credentials: 'include' });
    } catch {
      // Logout locally even if server call fails
    }
    setUser(null);
  }, []);

  // Show nothing while checking auth status
  if (loading) {
    return null;
  }

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
