import { Tour, type TourStep } from "@/components/ui/tour";
import { useOnboarding } from "@/state/onboarding-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * Anchors for the guided tour. They are `data-tour` attributes rather than
 * selectors built from class names or `aria-label` text, so restyling or
 * rewording a control cannot silently break the tour.
 */
export const TOUR_ANCHOR = {
  addProject: "add-project",
  newWorktree: "new-worktree",
  newTab: "new-tab",
  launchAgent: "launch-agent",
} as const;

const STEPS: TourStep[] = [
  {
    id: "add-project",
    target: `[data-tour="${TOUR_ANCHOR.addProject}"]`,
    title: "Add another project",
    description:
      "This menu adds a project — a local checkout, a clone, or a repo over SSH — and creates worktrees inside the current one.",
    placement: "top",
  },
  {
    id: "new-worktree",
    target: `[data-tour="${TOUR_ANCHOR.newWorktree}"]`,
    title: "Create a worktree",
    description:
      "A worktree is an isolated branch checkout with its own terminals and agents. Start one per task and run them side by side.",
    placement: "bottom",
  },
  {
    id: "new-tab",
    target: `[data-tour="${TOUR_ANCHOR.newTab}"]`,
    title: "Open a terminal tab",
    description:
      "New tabs open in the selected worktree — a shell, a specific WSL distribution, or an embedded browser.",
    placement: "bottom",
  },
  {
    id: "launch-agent",
    target: `[data-tour="${TOUR_ANCHOR.launchAgent}"]`,
    title: "Launch an agent",
    description:
      "Pick an installed agent to open it in its own tab, wired up to report status back to Pragma. Pin the ones you use most.",
    placement: "left",
  },
];

/**
 * The short guided tour that runs after onboarding, once a project is open.
 *
 * It waits for a project because three of its four anchors only exist then —
 * pointing at an empty shell would teach nothing. Finishing or skipping it
 * persists, so it runs once.
 */
export function WorkspaceTour() {
  const onboarding = useOnboarding();
  const workspace = useWorkspace();
  const ready = onboarding.tourPending && !workspace.loading && workspace.projects.length > 0;

  return <Tour onFinish={() => void onboarding.finishTour()} open={ready} steps={STEPS} />;
}
