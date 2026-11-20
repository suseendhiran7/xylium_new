import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);
const ROLES = ['viewer', 'operator', 'admin', 'superadmin'];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/api/auth/me');
      setCsrfToken(me.csrfToken);
      setUser(me.user);
    } catch {
      setCsrfToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setUser(null);
    });
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    const r = await api.post('/api/auth/login', { email, password });
    setCsrfToken(r.csrfToken);
    setUser(r.user);
  };

  const logout = async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setCsrfToken(null);
      setUser(null);
    }
  };

  const can = (minRole) => !!user && ROLES.indexOf(user.role) >= ROLES.indexOf(minRole);

  return <AuthContext.Provider value={{ user, login, logout, can, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
