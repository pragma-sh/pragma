import { router, Stack } from "expo-router";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { Monogram, NavGroup, NavRow } from "@/components/NavRow";
import { useProjects, useProjectStatus } from "@/lib/data/data-context";
import type { Project } from "@/lib/types";

/** Top-level list of all projects, styled as iOS Settings navigation rows. */
export default function ProjectsScreen() {
  const projects = useProjects();
  const insets = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen options={{ title: "Projects" }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
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
