import { Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { worktreeActivityLabel, type WorktreeActivity } from "@/state/worktree-activity-store";

/** A commit / push / PR action as one status line: spinner (or outcome) and its label. */
export function WorktreeActivityLine({
  activity,
  className,
}: {
  activity: WorktreeActivity;
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}
      data-state={activity.state}
    >
      {activity.state === "running" ? (
        <Loader2 aria-hidden className="size-3 shrink-0 animate-spin text-warning" />
      ) : activity.state === "done" ? (
        <Check aria-hidden className="size-3 shrink-0 text-success" />
      ) : (
        <X aria-hidden className="size-3 shrink-0 text-destructive" />
      )}
      <span
        className={cn(
          "truncate",
          activity.state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {worktreeActivityLabel(activity)}
      </span>
    </span>
  );
}
