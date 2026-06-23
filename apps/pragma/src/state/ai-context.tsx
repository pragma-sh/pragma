import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { aiSetupDismissed, aiStatus, setAiSetupDismissed, type AiStatus } from "@/lib/tauri";

interface AiContextValue {
  /** Latest AI status, or null until the first load resolves. */
  status: AiStatus | null;
  /** True while the initial load is in flight. */
  loading: boolean;
  /**
   * Whether AI features can run (an authenticated provider exposes a usable
   * model). Gates every AI affordance in the UI — e.g. the commit-message hint.
   */
  available: boolean;
  /**
   * True when the full-screen setup modal should show: the user has not finished
   * Pragma's AI onboarding (Done or Skip). Unlike GitHub, pi credentials may
   * already exist from the shared `~/.pi/agent/auth.json` CLI store, so this is
   * intentionally independent of {@link available}. False until the first load
   * resolves.
   */
  needsSetup: boolean;
  /** Re-reads status from the backend (after a sign-in / API key / skip). */
  refresh: () => Promise<void>;
  /** Persists the skip flag and refreshes so the modal dismisses. */
  dismissSetup: () => Promise<void>;
}

const AiContext = createContext<AiContextValue | null>(null);

/**
 * Holds AI availability and the actions that mutate it. `available` is the
 * single gate for AI features; `needsSetup` drives the first-run setup modal.
 * All pi SDK work happens in the `pragma-ai` sidecar behind the Rust backend;
 * this context only tracks the auth/availability state it reports.
 */
export function AiProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    let next: AiStatus = { available: false, signedIn: [] };
    let skip = false;

    try {
      next = await aiStatus();
    } catch {
      // Sidecar/Bun failures should not suppress the setup modal — only the
      // persisted skip flag may do that. Treat AI as unavailable so the user
      // can still connect a provider or skip explicitly.
    }

    try {
      skip = await aiSetupDismissed();
    } catch {
      // If we cannot read the skip flag, default to showing setup rather than
      // silently hiding the only path to sign in.
      skip = false;
    }

    setStatus(next);
    setDismissed(skip);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dismissSetup = useCallback(async () => {
    try {
      await setAiSetupDismissed(true);
    } finally {
      setDismissed(true);
    }
  }, []);

  const value = useMemo<AiContextValue>(() => {
    const available = status?.available ?? false;
    return {
      status,
      loading,
      available,
      needsSetup: !loading && !dismissed,
      refresh,
      dismissSetup,
    };
  }, [status, loading, dismissed, refresh, dismissSetup]);

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

/** Access the AI availability context. Throws outside an {@link AiProvider}. */
export function useAi(): AiContextValue {
  const value = useContext(AiContext);
  if (!value) {
    throw new Error("useAi must be used within an AiProvider");
  }
  return value;
}
