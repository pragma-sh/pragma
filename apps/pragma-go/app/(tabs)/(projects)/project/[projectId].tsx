import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NavGroup } from "@/components/NavRow";
import { renderNewWorktreeButton } from "@/components/NewWorktreeButton";
import { Text } from "@/components/ui/text";
import { WorktreeNavRow } from "@/components/WorktreeNavRow";
import { useProject, useProjectRootPath, useWorktreeTree } from "@/lib/data/data-context";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/** A project's top-level view: its root worktree(s) as navigation rows. */
export default function ProjectScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const roots = useWorktreeTree(projectId);
  const insets = useSafeAreaInsets();
  useViewedProjectRoot(useProjectRootPath(projectId));

  return (
    <>
      <Stack.Screen
        options={{
          title: project?.name ?? "Project",
          headerRight: renderNewWorktreeButton,
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
    </>
  );
}
