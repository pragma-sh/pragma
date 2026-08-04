// Pure routing half of push handling: no React Native imports, so it is
// testable under Vitest and safe to import anywhere.

/** Where the host says an alert came from. Sent as the push's `data`. */
export interface PushAlertData {
  worktreeId?: unknown;
  tabId?: unknown;
  agent?: unknown;
}

/** An expo-router destination for a tapped notification. */
export interface PushRoute {
  pathname: "/chat/[tabId]";
  params: { tabId: string; worktreeId?: string; agent?: string };
}

/**
 * Resolves the screen a tapped notification should open: the agent's own chat
 * tab. Returns null for a notification without routing data (the test push), so
 * the caller leaves the user where they are.
 */
export function pushRoute(data: PushAlertData | null | undefined): PushRoute | null {
  const tabId = asString(data?.tabId);
  if (!tabId) return null;
  const worktreeId = asString(data?.worktreeId);
  const agent = asString(data?.agent);
  return {
    pathname: "/chat/[tabId]",
    params: {
      tabId,
      ...(worktreeId ? { worktreeId } : {}),
      ...(agent ? { agent } : {}),
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
