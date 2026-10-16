import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Session } from './api';

interface AuthState {
  session: Session | null;
  loading: boolean;
  login: (school: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Session>('/auth/me')
      .then(setSession)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error('session check failed');
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(
    async (school: string, email: string, password: string) => setSession(await api.post<Session>('/auth/login', { school, email, password })),
    [],
  );
  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setSession(null);
    }
  }, []);
  const refresh = useCallback(async () => setSession(await api.get<Session>('/auth/me')), []);
  const can = useCallback((p: string) => Boolean(session?.permissions.includes(p)), [session]);

  return <Ctx.Provider value={{ session, loading, login, logout, refresh, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
