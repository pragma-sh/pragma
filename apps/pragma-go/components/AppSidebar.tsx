import { router, usePathname } from "expo-router";
import { ScrollView, View } from "react-native";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { IconSymbol } from "@/components/IconSymbol";
import { Text } from "@/components/ui/text";
import { SidebarRow } from "@/components/SidebarRow";
import {
  useInbox,
  useProjects,
  useProjectStatus,
  useWorktreeStatus,
  useWorktreeTree,
} from "@/lib/data/data-context";
import { useScratchpads } from "@/lib/use-scratchpads";
import { worktreeLabel, type WorktreeNode } from "@/lib/worktree-tree";
import type { Project } from "@/lib/types";

// The wide-layout navigation column, mirroring the desktop sidebar: Inbox on
// top, then every project with its worktree tree. The tree is always visible
// rather than drilled into, which is the whole point of having the width.
//
// Only the *selected* worktree expands to its scratchpads. Listing scratchpads
// costs a host round trip per worktree, so eagerly expanding every one would
// turn opening the app into dozens of requests for rows nobody is reading.

/** Fixed width of the navigation column in the wide layout. */
const SIDEBAR_WIDTH = 280;

/** The wide-layout navigation column. */
export function AppSidebar() {
  const projects = useProjects();
  const { items } = useInbox();
  const pathname = usePathname();

  return (
    <View
      className="h-full border-r border-sidebar-border bg-sidebar"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <ScrollView contentContainerStyle={{ gap: 4, padding: 12 }}>
        <Text className="px-2 pb-2 text-lg font-semibold text-foreground">Pragma Go</Text>
        <SidebarRow
          badge={items.length > 0 ? String(items.length) : undefined}
          icon={<IconSymbol fallback="✉" name="tray.full.fill" size={16} />}
          onPress={() => router.navigate("/inbox")}
          selected={pathname.startsWith("/inbox")}
          title="Inbox"
        />
        <View className="h-2" />
        {projects.map((project) => (
          <ProjectSection key={project.id} pathname={pathname} project={project} />
        ))}
      </ScrollView>
    </View>
  );
}

/** One project header plus its worktree tree. */
function ProjectSection({ project, pathname }: { project: Project; pathname: string }) {
  const roots = useWorktreeTree(project.id);
  const status = useProjectStatus(project.id);

  return (
    <View className="gap-0.5">
      <SidebarRow
        onPress={() =>
          router.navigate({ pathname: "/project/[projectId]", params: { projectId: project.id } })
        }
        selected={pathname === `/project/${project.id}`}
        title={project.name}
        trailing={<AgentStatusDot status={status} />}
        variant="section"
      />
      {roots.map((node) => (
        <WorktreeBranch depth={0} key={node.worktree.id} node={node} pathname={pathname} />
      ))}
    </View>
  );
}

/** A worktree row, its children, and — when selected — its scratchpads. */
function WorktreeBranch({
  node,
  depth,
  pathname,
}: {
  node: WorktreeNode;
  depth: number;
  pathname: string;
}) {
  const { worktree } = node;
  const selected = pathname === `/worktree/${worktree.id}`;
  const status = useWorktreeStatus(worktree.id);

  return (
    <>
      <SidebarRow
        depth={depth}
        icon={
          <IconSymbol
            fallback={worktree.isMain ? "★" : "⎇"}
            name={worktree.isMain ? "circle.fill" : "arrow.triangle.branch"}
            size={14}
          />
        }
        onPress={() =>
          router.navigate({
            pathname: "/worktree/[worktreeId]",
            params: { worktreeId: worktree.id },
          })
        }
        selected={selected}
        title={worktreeLabel(worktree)}
        trailing={<AgentStatusDot status={status} />}
      />
      {selected ? <ScratchpadBranch depth={depth + 1} worktreeId={worktree.id} /> : null}
      {node.children.map((child) => (
        <WorktreeBranch
          depth={depth + 1}
          key={child.worktree.id}
          node={child}
          pathname={pathname}
        />
      ))}
    </>
  );
}

/** The selected worktree's scratchpads, as leaf rows. */
function ScratchpadBranch({ worktreeId, depth }: { worktreeId: string; depth: number }) {
  const { scratchpads } = useScratchpads(worktreeId);
  const pathname = usePathname();

  return (
    <>
      {scratchpads.map((scratchpad) => (
        <SidebarRow
          depth={depth}
          icon={<IconSymbol fallback="📝" name="doc.text" size={14} />}
          key={scratchpad.id}
          onPress={() =>
            router.navigate({
              pathname: "/scratchpad/[scratchpadId]",
              params: {
                scratchpadId: scratchpad.id,
                filePath: scratchpad.filePath,
                title: scratchpad.title,
                worktreeId,
              },
            })
          }
          selected={pathname === `/scratchpad/${scratchpad.id}`}
          title={scratchpad.title}
        />
      ))}
    </>
  );
}
