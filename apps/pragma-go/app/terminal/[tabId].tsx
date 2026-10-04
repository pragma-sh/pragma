import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";

import { TerminalSurface } from "@/components/terminal/TerminalSurface";
import { useProjectRootPath, useTerminalTab, useWorktree } from "@/lib/data/data-context";
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
  const worktree = useWorktree(worktreeId ?? tab?.worktreeId ?? "");
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  const [attached, setAttached] = useState(false);
  const [shellTitle, setShellTitle] = useState<string | null>(null);

  // Attach only while the screen is in front: a backgrounded terminal should
  // not hold the session's viewport, and the host expires the lease if this
  // app is suspended before it can release.
  useFocusEffect(
    useCallback(() => {
      setAttached(true);
      return () => setAttached(false);
    }, []),
  );

  const label = shellTitle ?? tab?.title ?? title ?? "Terminal";

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
      <Stack.Screen options={{ title: label }} />
      <TerminalSurface attached={attached} onTitle={setShellTitle} tabId={tabId} />
    </SafeAreaView>
  );
}
