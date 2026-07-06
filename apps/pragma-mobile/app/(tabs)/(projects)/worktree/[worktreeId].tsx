import { router, Stack, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { IconSymbol } from "@/components/IconSymbol";
import { NavGroup, NavRow } from "@/components/NavRow";
import { renderNewWorktreeButton } from "@/components/NewWorktreeButton";
import { Text } from "@/components/ui/text";
import { WorktreeNavRow } from "@/components/WorktreeNavRow";
import { useAgentTabs, useChildWorktrees, useWorktree } from "@/lib/data/data-context";
import type { AgentTab } from "@/lib/types";
import { worktreeLabel, type WorktreeNode } from "@/lib/worktree-tree";

/** A worktree's view: nested child worktrees, then its agent tabs. Nests until
 *  a worktree has no children left — same recursion as the desktop sidebar. */
export default function WorktreeScreen() {
  const { worktreeId } = useLocalSearchParams<{ worktreeId: string }>();
  const worktree = useWorktree(worktreeId);
  const children = useChildWorktrees(worktreeId);
  const agentTabs = useAgentTabs(worktreeId);
  const insets = useSafeAreaInsets();

  const empty = children.length === 0 && agentTabs.length === 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: worktree ? worktreeLabel(worktree) : "Worktree",
          headerRight: renderNewWorktreeButton,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: insets.bottom + 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <WorktreesGroup nodes={children} />
        <AgentTabsGroup tabs={agentTabs} />
        {empty ? (
          <Text className="px-4 py-6 text-muted-foreground">
            No nested worktrees or agents here.
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

/** The nested child worktrees section, or nothing when there are none. */
function WorktreesGroup({ nodes }: { nodes: WorktreeNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <NavGroup title="Worktrees">
      {nodes.map((node) => (
        <WorktreeNavRow key={node.worktree.id} worktree={node.worktree} />
      ))}
    </NavGroup>
  );
}

/** The worktree's agent tabs section, or nothing when there are none. */
function AgentTabsGroup({ tabs }: { tabs: AgentTab[] }) {
  if (tabs.length === 0) return null;
  return (
    <NavGroup title="Agents">
      {tabs.map((tab) => (
        <NavRow
          key={tab.id}
          leading={<IconSymbol color="hsl(240 4% 46%)" fallback="◆" name="sparkles" size={18} />}
          onPress={() => router.push({ pathname: "/chat/[tabId]", params: { tabId: tab.id } })}
          subtitle={tab.agent}
          title={tab.title}
          trailing={<AgentStatusDot status={tab.status} />}
        />
      ))}
    </NavGroup>
  );
}
