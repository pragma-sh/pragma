import { createContext, useContext, useMemo, type ReactNode } from "react";

interface OnboardingFlowValue {
  /** The flow's progress row, rendered at the top of the current step. */
  progress: ReactNode;
  /**
   * Reports the natural height of the step's copy column, in px, so the modal
   * can size itself to the step instead of pinning every step to one box.
   */
  reportContentHeight: (px: number) => void;
  /** Abandons the whole flow, not just this step. */
  skipAll: () => void;
}

/**
 * What the modal hands to whichever step is showing: the progress row and the
 * flow-wide skip.
 *
 * They travel by context rather than as props on every step because the
 * progress row is rendered *inside* `OnboardingFrame`'s right-hand column — a
 * step with a media panel spans the dialog's full height, so the row cannot
 * live above the step — and threading two unchanging values through seven step
 * components would be noise.
 */
const OnboardingFlowContext = createContext<OnboardingFlowValue | null>(null);

export function OnboardingProgressProvider({
  children,
  progress,
  reportContentHeight,
  skipAll,
}: {
  children: ReactNode;
  progress: ReactNode;
  reportContentHeight: (px: number) => void;
  skipAll: () => void;
}) {
  const value = useMemo(
    () => ({ progress, reportContentHeight, skipAll }),
    [progress, reportContentHeight, skipAll],
  );
  return <OnboardingFlowContext.Provider value={value}>{children}</OnboardingFlowContext.Provider>;
}

/**
 * The flow values for the current step, or `null` when a step is rendered
 * outside the modal (tests, Settings replays).
 */
export function useOnboardingFlow(): OnboardingFlowValue | null {
  return useContext(OnboardingFlowContext);
}
