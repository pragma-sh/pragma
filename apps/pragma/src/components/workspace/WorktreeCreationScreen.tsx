import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorktreeCreation, type WorktreeCreationStep } from "@/state/worktree-creation-context";

/** One step row: a status marker plus its label, pulsing while active. */
function StepRow({ step }: { step: WorktreeCreationStep }) {
  return (
    <li className="flex items-center gap-3" data-status={step.status}>
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          step.status === "done"
            ? "border-primary bg-primary text-primary-foreground"
            : step.status === "active"
              ? "border-primary text-primary"
              : "border-muted-foreground/40 text-muted-foreground",
        )}
      >
        {step.status === "done" ? <Check className="size-3" /> : null}
      </span>
      <span
        className={cn(
          "text-sm",
          step.status === "active"
            ? "animate-pulse font-medium text-foreground"
            : step.status === "done"
              ? "text-muted-foreground"
              : "text-muted-foreground/60",
        )}
      >
        {step.label}
      </span>
    </li>
  );
}

/**
 * Full-frame progress screen shown while a worktree is being created. It
 * replaces the terminal area (rather than overlaying it) because native
 * browser webviews float above HTML and would clip an overlay.
 */
export function WorktreeCreationScreen() {
  const { creation, dismiss } = useWorktreeCreation();
  if (!creation) {
    return null;
  }
  return (
    <section className="bg-canvas flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-foreground text-2xl font-semibold">Creating worktree</h1>
          <p className="text-muted-foreground text-sm">{creation.branch}</p>
        </div>
        <ul className="space-y-3">
          {creation.steps.map((step) => (
            // A failed run stops pulsing: the step it died on is no longer running.
            <StepRow
              key={step.id}
              step={
                creation.error && step.status === "active" ? { ...step, status: "pending" } : step
              }
            />
          ))}
        </ul>
        {creation.error ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-destructive">{creation.error}</p>
            <Button size="sm" variant="secondary" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
