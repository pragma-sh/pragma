import { Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useState } from "react";
import { type ColorValue, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LaunchAgentButton } from "@/components/LaunchAgentButton";
import { LaunchSheet } from "@/components/LaunchSheet";
import { NavGroup } from "@/components/NavRow";
import { Text } from "@/components/ui/text";
import { WorktreeNavRow } from "@/components/WorktreeNavRow";
import { useProject, useProjectRootPath, useWorktreeTree } from "@/lib/data/data-context";
import { hapticImpact } from "@/lib/haptics";
import type { Project, Worktree } from "@/lib/types";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";
import type { WorktreeNode } from "@/lib/worktree-tree";

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
      <ProjectHeader
        headerRight={renderLaunchAgentButton}
        mainWorktree={mainWorktree}
        project={project}
      />
      <WorktreeList insetBottom={insets.bottom} roots={roots} />
      <ProjectLaunchSheet
        mainWorktree={mainWorktree}
        onOpenChange={setLaunchOpen}
        open={launchOpen}
        projectId={projectId}
      />
    </>
  );
}

function ProjectHeader({
  headerRight,
  mainWorktree,
  project,
}: {
  headerRight: ({ tintColor }: { tintColor?: ColorValue }) => ReactNode;
  mainWorktree: Worktree | undefined;
  project: Project | undefined;
}) {
  return (
    <Stack.Screen
      options={{
        title: project?.name ?? "Project",
        headerRight: mainWorktree ? headerRight : undefined,
      }}
    />
  );
}

/** The project's root worktrees, or an empty state when none have loaded. */
function WorktreeList({ insetBottom, roots }: { insetBottom: number; roots: WorktreeNode[] }) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, paddingBottom: insetBottom + 24 }}
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
  );
}

/** The launch sheet for the project's main worktree, or nothing without one. */
function ProjectLaunchSheet({
  mainWorktree,
  onOpenChange,
  open,
  projectId,
}: {
  mainWorktree: Worktree | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  if (!mainWorktree) return null;
  return (
    <LaunchSheet
      onOpenChange={onOpenChange}
      open={open}
      projectId={projectId}
      worktreeId={mainWorktree.id}
    />
  );
}
