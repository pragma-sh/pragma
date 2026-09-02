import { useCallback, useState, type ComponentType } from "react";

import { OnboardingProgressProvider } from "@/components/onboarding/onboarding-progress";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  AgentPluginsStep,
  AiStep,
  GitHubStep,
  ProjectStep,
  SkillsStep,
  ThemeStep,
  WelcomeStep,
  type StepProps,
} from "@/components/onboarding/OnboardingSteps";
import {
  dialogBox,
  quantizeHeight,
  useOnboardingLayout,
} from "@/components/onboarding/use-onboarding-layout";
import { useOnboarding } from "@/state/onboarding-context";

/** The first-run flow, in order. Each entry owns its own copy and actions. */
const STEPS: { id: string; label: string; Step: ComponentType<StepProps> }[] = [
  { id: "welcome", label: "Welcome", Step: WelcomeStep },
  { id: "github", label: "GitHub", Step: GitHubStep },
  { id: "ai", label: "AI provider", Step: AiStep },
  { id: "agents", label: "Agents", Step: AgentPluginsStep },
  { id: "skills", label: "Skills", Step: SkillsStep },
  { id: "theme", label: "Theme", Step: ThemeStep },
  { id: "project", label: "Project", Step: ProjectStep },
];

/**
 * The single first-run tutorial. It replaces the separate GitHub / AI / agent
 * plugin setup modals: one non-dismissible flow with a progress bar, in which
 * every step can be skipped — its own skip, or the footer's flow-wide
 * "Skip setup" — and which persists completion so it never returns. A step's
 * primary action stays disabled until that step's work is done, so skipping is
 * an explicit choice rather than a mislabelled "Continue".
 *
 * Skipping a step still records that step's own "don't ask again" flag (GitHub
 * and AI both keep one), so the old modals' behavior is preserved without the
 * old modals. Mounted once in `App.tsx`.
 */
export function OnboardingModal() {
  const onboarding = useOnboarding();
  const layout = useOnboardingLayout();
  const [index, setIndex] = useState(0);
  // The height the current step's copy column asked for, rounded to the step
  // size the dialog is sized in. Returning `previous` when the rounded value
  // matches is the whole anti-flicker mechanism: React bails out, no size prop
  // changes, and `layout="size"` has nothing to animate.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const reportContentHeight = useCallback((px: number) => {
    const wanted = quantizeHeight(px);
    setContentHeight((previous) => (previous === wanted ? previous : wanted));
  }, []);
  const box = dialogBox(layout, contentHeight);
  const entry = STEPS[index] ?? STEPS[0];

  if (!entry) return null;
  const { Step, label } = entry;

  function goTo(next: number) {
    if (next >= STEPS.length) {
      void onboarding.finish();
      return;
    }
    setIndex(Math.max(0, next));
  }

  return (
    <Dialog open={onboarding.active}>
      <DialogContent
        // The box follows the step's own content between a floor and a ceiling
        // rather than being pinned: steps differ in height, and one fixed box
        // either crops the shortest step's clip or scrolls the tallest for no
        // reason. Both dimensions are explicit pixels computed from the measured
        // content — never `auto` or `fit-content`, which the size animation
        // would re-derive on every frame while the content reflows underneath
        // it, so the dialog would chase itself. One measurement in, one box out,
        // one transition per step.
        //
        // Side by side the width follows the height: the clip's panel is 16:9
        // and as tall as the row, so the box is the copy column plus a panel the
        // clip fills edge to edge. Stacked the width is fixed and the banner
        // spans it. The shape comes from `useOnboardingLayout`, which the step
        // frame reads too, so the box and its contents cannot disagree.
        className="flex flex-col gap-0 overflow-hidden p-0"
        // `maxWidth` too, not just `width`: `DialogContent` ships a
        // `sm:max-w-sm` of its own, which would otherwise clamp the box to 24rem.
        style={{ height: box.height, maxWidth: box.width, width: box.width }}
        // Non-dismissible: the flow is left through a step's own skip or its
        // final screen, never by clicking away from a half-finished sign-in.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        {/* One visible heading per step lives inside the frame; the dialog's own
          title/description stay for assistive tech only. */}
        <DialogTitle className="sr-only">Set up Pragma</DialogTitle>
        <DialogDescription className="sr-only">
          A short, skippable walkthrough of everything Pragma needs to run your agents.
        </DialogDescription>
        <OnboardingProgressProvider
          progress={
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <span className="tabular-nums">
                  Step {index + 1} of {STEPS.length}
                </span>
              </div>
              <Progress value={((index + 1) / STEPS.length) * 100} />
            </div>
          }
          reportContentHeight={reportContentHeight}
          skipAll={() => void onboarding.finish()}
        >
          <Step
            key={entry.id}
            onBack={index > 0 ? () => goTo(index - 1) : undefined}
            onNext={() => goTo(index + 1)}
          />
        </OnboardingProgressProvider>
      </DialogContent>
    </Dialog>
  );
}
