import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";

import { TerminalSurface } from "@/components/terminal/TerminalSurface";
import { useProjectRootPath, useTerminalTab, useWorktree } from "@/lib/data/data-context";
import { useScreenFocused } from "@/lib/use-screen-focused";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/**
 * One terminal session, full screen and outside the bottom tabs.
 *
 * Attaching here joins the session the host is already running — it does not
 * start a shell — so leaving simply detaches: the process keeps running, and
 * the desktop keeps its own view of it. Ending a session is the explicit close
 * action on the terminal row, never a back gesture.
 */
export default function TerminalScreen() {
  const { tabId, title, worktreeId } = useLocalSearchParams<{
    tabId: string;
    title?: string;
    worktreeId?: string;
  }>();
  const tab = useTerminalTab(tabId);
  useViewTerminalProject(worktreeId ?? tab?.worktreeId);
  // Attach only while the screen is in front: a backgrounded terminal should
  // not hold the session's viewport, and the host expires the lease if this
  // app is suspended before it can release.
  const attached = useScreenFocused();
  const [shellTitle, setShellTitle] = useState<string | null>(null);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
      <Stack.Screen options={{ title: terminalLabel(shellTitle, tab?.title, title) }} />
      <TerminalSurface attached={attached} onTitle={setShellTitle} tabId={tabId} />
    </SafeAreaView>
  );
}

/** Marks the terminal's project as the one in view, once its worktree is known. */
function useViewTerminalProject(worktreeId: string | undefined): void {
  const worktree = useWorktree(worktreeId ?? "");
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
}

/** The shell's own title, else the tab's, else the one it was opened with. */
function terminalLabel(
  shellTitle: string | null,
  tabTitle: string | undefined,
  openedTitle: string | undefined,
): string {
  return shellTitle ?? tabTitle ?? openedTitle ?? "Terminal";
}
