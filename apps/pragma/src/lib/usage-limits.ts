import { usageSeverity, type UsageSeverity } from "@pragma-sh/accounts-view";

/** Progress-indicator fill for each usage severity. */
const PROGRESS_CLASS: Record<UsageSeverity, string> = {
  ok: "[&_[data-slot=progress-indicator]]:bg-primary",
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  critical: "[&_[data-slot=progress-indicator]]:bg-destructive",
};

/** Background for a bare usage bar at each severity. */
const TONE_CLASS: Record<UsageSeverity, string> = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** Maps usage severity onto semantic progress colors. */
export function progressColorClass(percent: number): string {
  return PROGRESS_CLASS[usageSeverity(percent)];
}

/** Background class for a bare usage bar at the same severity thresholds. */
export function usageToneClass(percent: number): string {
  return TONE_CLASS[usageSeverity(percent)];
}
