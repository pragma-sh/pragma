import { Stack, useLocalSearchParams } from "expo-router";
import { type ColorValue, ScrollView } from "react-native";
import { useCallback, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LaunchAgentButton } from "@/components/LaunchAgentButton";
import { LaunchSheet } from "@/components/LaunchSheet";
import { NavGroup } from "@/components/NavRow";
import { Text } from "@/components/ui/text";
import { WorktreeNavRow } from "@/components/WorktreeNavRow";
import { useProject, useProjectRootPath, useWorktreeTree } from "@/lib/data/data-context";
import { hapticImpact } from "@/lib/haptics";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/** A project's top-level view: its root worktree(s) as navigation rows. The
 *  header "+" launches an agent in the main worktree — the project's primary
 *  mobile action — while a fresh branch is reachable from the launch sheet's
 *  "New branch" tab. */
export default function ProjectScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const roots = useWorktreeTree(projectId);
  const mainWorktree = roots.find((node) => node.worktree.isMain)?.worktree;
  const insets = useSafeAreaInsets();
  useViewedProjectRoot(useProjectRootPath(projectId));
  const [launchOpen, setLaunchOpen] = useState(false);

  const openLaunchSheet = useCallback(() => {
    hapticImpact();
    setLaunchOpen(true);
  }, []);
  const renderLaunchAgentButton = useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <LaunchAgentButton color={tintColor ?? "black"} onPress={openLaunchSheet} />
    ),
    [openLaunchSheet],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: project?.name ?? "Project",
          headerRight: mainWorktree ? renderLaunchAgentButton : undefined,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {roots.length === 0 ? (
          <Text className="px-4 py-6 text-muted-foreground">No worktrees loaded.</Text>
        ) : (
          <NavGroup title="Worktrees">
            {roots.map((node) => (
              <WorktreeNavRow key={node.worktree.id} worktree={node.worktree} />
            ))}
          </NavGroup>
        )}
      </ScrollView>
      {mainWorktree ? (
        <LaunchSheet
          onOpenChange={setLaunchOpen}
          open={launchOpen}
          projectId={projectId}
          worktreeId={mainWorktree.id}
        />
      ) : null}
    </>
  );
}
