import { constants } from "@pragma/constants";

/**
 * The label a tab carries before anything has named it. Same source of truth as
 * the desktop's `defaultTabTitle`, so both clients say "Shell" for an unnamed
 * terminal instead of inventing their own word.
 */
export const DEFAULT_TAB_TITLE = constants.tabs.defaultTitles.fallback;

/**
 * An agent session's display title, matching what the desktop shows on its
 * agent tab: the tab's own name (a user rename, or the agent-reported session
 * name the desktop persists onto the tab), else the agent's last reported
 * session name, else the shared fallback.
 *
 * Deliberately ignores shell OSC titles — the desktop's auto-title reducer
 * skips any tab with an `agentId`, so mirroring a live terminal title here
 * would show a different name than the desktop for the same session.
 */
export function agentSessionTitle(
  tabTitle: string | null | undefined,
  sessionName?: string | null,
): string {
  const named = tabTitle?.trim();
  // A tab still carrying the default title counts as unnamed, so a session name
  // reported before the desktop persisted it onto the tab still shows.
  if (named && named !== DEFAULT_TAB_TITLE) return named;
  return sessionName?.trim() || DEFAULT_TAB_TITLE;
}
