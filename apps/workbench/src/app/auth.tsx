import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthApiError, getCurrentPrincipal, type Principal } from "../api/auth";
import { queryClient } from "./query-client";

type AuthState = "checking" | "available" | "required" | "unavailable";
interface AuthContextValue {
  state: AuthState;
  principal: Principal | null;
  scopeToken: number;
  // ESLint's base rule does not understand TypeScript method parameters.
  // eslint-disable-next-line no-unused-vars
  markAvailable(principal: Principal): void;
  markRequired: () => void;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [scopeToken, setScopeToken] = useState(0);

  const invalidateScope = useCallback(() => {
    queryClient.clear();
    setScopeToken((value) => value + 1);
  }, []);

  const markRequired = useCallback(() => {
    setPrincipal(null);
    setState("required");
    invalidateScope();
  }, [invalidateScope]);

  const markAvailable = useCallback((nextPrincipal: Principal) => {
    setPrincipal(nextPrincipal);
    setState("available");
    invalidateScope();
  }, [invalidateScope]);

  const verifySession = useCallback(async (signal?: AbortSignal) => {
    setState("checking");
    try {
      const nextPrincipal = await getCurrentPrincipal(signal);
      if (!signal?.aborted) markAvailable(nextPrincipal);
    } catch (error) {
      if (signal?.aborted) return;
      setPrincipal(null);
      setState(error instanceof AuthApiError && error.status === 401 ? "required" : "unavailable");
      invalidateScope();
    }
  }, [invalidateScope, markAvailable]);

  useEffect(() => {
    const controller = new AbortController();
    void getCurrentPrincipal(controller.signal).then((nextPrincipal) => {
      if (!controller.signal.aborted) markAvailable(nextPrincipal);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setPrincipal(null);
      setState(error instanceof AuthApiError && error.status === 401 ? "required" : "unavailable");
      invalidateScope();
    });
    window.addEventListener("workbench:auth-expired", markRequired);
    return () => {
      controller.abort();
      window.removeEventListener("workbench:auth-expired", markRequired);
    };
  }, [invalidateScope, markAvailable, markRequired]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      principal,
      scopeToken,
      markAvailable,
      markRequired,
      retry: () => { void verifySession(); },
    }),
    [markAvailable, markRequired, principal, scopeToken, state, verifySession],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
