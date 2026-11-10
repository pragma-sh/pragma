import { Check, CircleDot, X } from "lucide-react";

import type { ChecksStatus } from "@/lib/github";
import { cn } from "@/lib/utils";

const CHECKS_STATE_LABEL: Partial<Record<ChecksStatus["state"], string>> = {
  success: "Checks passed",
  failure: "Checks failed",
  pending: "Checks pending",
};

/**
 * GitHub's CI rollup glyph: a green check, a red cross, or an amber dot while
 * checks run. Nothing for `none`/`neutral`, so a repo without CI shows no mark.
 */
export function ChecksStateIcon({
  state,
  className,
}: {
  state: ChecksStatus["state"] | null | undefined;
  className?: string;
}) {
  const label = state ? CHECKS_STATE_LABEL[state] : undefined;
  if (!state || !label) return null;
  const Glyph = state === "success" ? Check : state === "failure" ? X : CircleDot;
  const tone =
    state === "success"
      ? "text-success"
      : state === "failure"
        ? "text-destructive"
        : "text-warning";
  return <Glyph aria-label={label} className={cn("size-4 shrink-0", tone, className)} />;
}
