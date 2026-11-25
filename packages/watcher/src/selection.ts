/** The launch-time choices the host hands a watcher started with a fresh launch. */
export interface WatcherLaunchSelection {
  modelId?: string;
  reasoningId?: string;
  modeId?: string;
  permissionModeId?: string;
  slashCommand?: string;
}

const FIELDS = ["modelId", "reasoningId", "modeId", "permissionModeId", "slashCommand"] as const;

/**
 * Reads the `--selection` argument. The host sends it only to a watcher it
 * starts together with a launch, so an absent or unreadable value means "no
 * selection to apply", never an error: the watcher's other duties must run.
 * Unset choices arrive as `null` on the wire and are dropped.
 */
export function parseLaunchSelection(
  value: string | undefined,
): WatcherLaunchSelection | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const selection: WatcherLaunchSelection = {};
  for (const field of FIELDS) {
    const choice = record[field];
    if (typeof choice === "string" && choice) selection[field] = choice;
  }
  return selection;
}
