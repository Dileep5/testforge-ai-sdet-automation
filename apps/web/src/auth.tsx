import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, post, request, setSessionLostHandler, type SessionUser } from "./api";

interface AuthValue {
  user: SessionUser | null;
  ready: boolean;
  sessionLost: boolean;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);

  useEffect(() => {
    setSessionLostHandler(() => {
      // Only a signed-in user can "lose" a session; an anonymous first visit is not an expiry.
      setUser((current) => {
        if (current) setSessionLost(true);
        return null;
      });
    });
    request<SessionUser>("/auth/me")
      .then(setUser)
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.code === "SESSION_EXPIRED") setSessionLost(true);
      })
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await post<SessionUser>("/auth/login", { email, password });
    setSessionLost(false);
    setUser(session);
  }, []);

  const logout = useCallback(async () => {
    try {
      await post<void>("/auth/logout");
    } finally {
      setSessionLost(false);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      ready,
      sessionLost,
      can: (permission) => user?.permissions.includes(permission) ?? false,
      login,
      logout,
    }),
    [user, ready, sessionLost, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
