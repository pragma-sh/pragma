import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRequiredContext } from "@/lib/context";

import type { GitHubAuthStatus } from "@pragma/constants";

import { githubAuthStatus, githubSignOut, setGithubSetupDismissed } from "@/lib/tauri";

interface GitHubContextValue {
  /** Latest auth status, or null until the first load resolves. */
  status: GitHubAuthStatus | null;
  /** True while the initial auth-status load is in flight. */
  loading: boolean;
  /** True once a token is stored (drives the subtab create/view vs logged-out). */
  authenticated: boolean;
  /**
   * True when the full-screen setup modal should show: not authenticated and the
   * user has not skipped setup. False until the first status load resolves.
   */
  needsSetup: boolean;
  /** Re-reads auth status from the backend (after sign-in / sign-out / skip). */
  refresh: () => Promise<void>;
  /** Persists the skip flag and refreshes so the modal dismisses. */
  dismissSetup: () => Promise<void>;
  /** Clears the stored token and refreshes. */
  signOut: () => Promise<void>;
}

const GitHubContext = createContext<GitHubContextValue | null>(null);

/**
 * Holds the GitHub authentication status and the actions that mutate it. The
 * status is the single gate for the setup modal (`needsSetup`) and the Pull
 * Request subtab's logged-out state (`authenticated`). All GitHub REST/GraphQL
 * work happens through the Octokit client in `lib/github.ts`; this context only
 * tracks the auth state surfaced by the Rust backend (token stored in its on-disk
 * 0600 token file).
 */
export function GitHubProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await githubAuthStatus();
      setStatus(next);
    } catch {
      // An unreachable backend (or unavailable Tauri IPC) means both sign-in and
      // dismissSetup would also fail — so gating on the full-screen, non-dismissible
      // setup modal would be an unrecoverable blocker. Degrade to "don't gate":
      // mark setup dismissed so `needsSetup` stays false while still reporting
      // not-authenticated (the PR subtab shows its logged-out state). A later
      // successful refresh replaces this with the real status.
      setStatus({ authenticated: false, ghAvailable: false, user: null, setupDismissed: true });
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissSetup = useCallback(async () => {
    await setGithubSetupDismissed(true);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await githubSignOut();
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<GitHubContextValue>(() => {
    const authenticated = status?.authenticated ?? false;
    return {
      status,
      loading,
      authenticated,
      needsSetup: status !== null && !authenticated && !status.setupDismissed,
      refresh,
      dismissSetup,
      signOut,
    };
  }, [status, loading, refresh, dismissSetup, signOut]);

  return <GitHubContext.Provider value={value}>{children}</GitHubContext.Provider>;
}

/** Accesses the GitHub authentication state and actions. */
export function useGitHub(): GitHubContextValue {
  return useRequiredContext(GitHubContext, "useGitHub");
}
