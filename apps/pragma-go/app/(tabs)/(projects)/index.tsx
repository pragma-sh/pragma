import { router, Stack } from "expo-router";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { Monogram, NavGroup, NavRow } from "@/components/NavRow";
import { Text } from "@/components/ui/text";
import { useProjects, useProjectStatus } from "@/lib/data/data-context";
import type { Project } from "@/lib/types";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/** Top-level list of all projects, styled as iOS Settings navigation rows. */
export default function ProjectsScreen() {
  const projects = useProjects();
  const insets = useSafeAreaInsets();
  // No project is in view here: the app theme falls back to the global layer.
  useViewedProjectRoot(null);

  return (
    <>
      {/* The header is hidden here, but the title still names this screen in the
          back control of everything pushed on top of it — without it the stack
          falls back to the route name, "index". */}
      <Stack.Screen options={{ headerShown: false, title: "Home" }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text className="mb-4 text-4xl font-bold text-foreground">Projects</Text>
        <NavGroup footer={`${projects.length} projects`}>
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </NavGroup>
      </ScrollView>
    </>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const status = useProjectStatus(project.id);
  return (
    <NavRow
      leading={<Monogram label={project.name} />}
      onPress={() =>
        router.push({ pathname: "/project/[projectId]", params: { projectId: project.id } })
      }
      subtitle={project.path}
      title={project.name}
      trailing={<AgentStatusDot status={status} />}
    />
  );
}
