export interface AuthUser {
  username: string;
  // Note: JWT token is stored in httpOnly cookie, not accessible from JS
}

export interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (username: string) => void;
  logout: () => void;
}

export interface LoginCredentials {
  username: string;
  password: string;
}
