"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type AutomaticSyncLockContextValue = {
  automaticSyncEnabled: boolean;
  setAutomaticSyncEnabled: (enabled: boolean) => void;
};

const AutomaticSyncLockContext = createContext<AutomaticSyncLockContextValue | null>(null);

export const AUTOMATIC_SYNC_LOCK_TOOLTIP =
  "Automação ativa. Desative em Configurações > Automação para liberar a sincronização manual.";

export function AutomaticSyncLockProvider({
  initialEnabled,
  children
}: {
  initialEnabled: boolean;
  children: ReactNode;
}) {
  const [automaticSyncEnabled, setAutomaticSyncEnabled] = useState(initialEnabled);

  useEffect(() => {
    let mounted = true;
    let loading = false;

    async function refresh() {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const response = await fetch("/api/processing/manual-sync-lock", {
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        const payload = await response.json().catch(() => null);
        if (!mounted) return;
        // On an auth/database failure, err on the side of disabling actions.
        setAutomaticSyncEnabled(response.ok && payload?.success
          ? payload.data?.automaticSyncEnabled === true
          : true);
      } catch {
        if (mounted) setAutomaticSyncEnabled(true);
      } finally {
        loading = false;
      }
    }

    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();

    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <AutomaticSyncLockContext.Provider value={{ automaticSyncEnabled, setAutomaticSyncEnabled }}>
      {children}
    </AutomaticSyncLockContext.Provider>
  );
}

export function useAutomaticSyncLock() {
  const context = useContext(AutomaticSyncLockContext);
  if (!context) {
    throw new Error("AutomaticSyncLockProvider não encontrado.");
  }
  return context;
}
