import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useRequiredContext } from "@/lib/context";
import { onboardingState, setOnboardingCompleted, setOnboardingTourCompleted } from "@/lib/tauri";

interface OnboardingContextValue {
  /** True until the persisted flags have been read once. */
  loading: boolean;
  /** True while the first-run tutorial modal should be showing. */
  active: boolean;
  /**
   * True once the tutorial is done but the guided workspace tour has not been
   * finished or skipped. The tour itself decides when it can actually run (it
   * needs a project and mounted anchors).
   */
  tourPending: boolean;
  /** Marks the tutorial finished (or skipped) and arms the guided tour. */
  finish: () => Promise<void>;
  /** Marks the guided tour finished (or skipped). */
  finishTour: () => Promise<void>;
  /** Replays the whole flow — tutorial first, then the tour. */
  restart: () => Promise<void>;
  /** Replays only the guided workspace tour, leaving the tutorial finished. */
  restartTour: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Owns first-run onboarding state: whether the tutorial modal and the guided
 * workspace tour still have to run. Both flags live in the backend settings
 * table, so they survive a reinstall of the UI but not of the profile.
 *
 * A backend that cannot be reached degrades to "already onboarded" rather than
 * gating the app behind a modal whose own actions would fail too — the same
 * trade-off `github-context` makes.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(true);
  const [tourCompleted, setTourCompleted] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void onboardingState()
      .then((state) => {
        if (!cancelled) {
          setCompleted(state.completed);
          setTourCompleted(state.tourCompleted);
        }
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(async () => {
    setCompleted(true);
    try {
      await setOnboardingCompleted(true);
    } catch {
      // A failed write only means the tutorial returns next launch; never block
      // the user inside the modal because of it.
    }
  }, []);

  const finishTour = useCallback(async () => {
    setTourCompleted(true);
    try {
      await setOnboardingTourCompleted(true);
    } catch {
      // Same trade-off as `finish`.
    }
  }, []);

  const restart = useCallback(async () => {
    setCompleted(false);
    setTourCompleted(false);
    try {
      await setOnboardingCompleted(false);
      await setOnboardingTourCompleted(false);
    } catch {
      // The in-memory flags already replayed the flow for this session.
    }
  }, []);

  const restartTour = useCallback(async () => {
    setTourCompleted(false);
    try {
      await setOnboardingTourCompleted(false);
    } catch {
      // Same trade-off as `finish`: the in-memory flag already armed the tour.
    }
  }, []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      loading,
      active: !loading && !completed,
      tourPending: !loading && completed && !tourCompleted,
      finish,
      finishTour,
      restart,
      restartTour,
    }),
    [loading, completed, tourCompleted, finish, finishTour, restart, restartTour],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

/** Accesses first-run onboarding state. Throws outside an {@link OnboardingProvider}. */
export function useOnboarding(): OnboardingContextValue {
  return useRequiredContext(OnboardingContext, "useOnboarding");
}
