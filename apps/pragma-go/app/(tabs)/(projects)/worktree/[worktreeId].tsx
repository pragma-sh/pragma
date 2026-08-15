import { router, Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useState } from "react";
import { Alert, ScrollView, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { LaunchAgentButton } from "@/components/LaunchAgentButton";
import { LaunchSheet } from "@/components/LaunchSheet";
import { NavGroup, NavRow } from "@/components/NavRow";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { WorktreeNavRow } from "@/components/WorktreeNavRow";
import { useConnection } from "@/lib/connection-context";
import {
  useAgentActions,
  useAgentTabs,
  useChildWorktrees,
  useProjectRootPath,
  useWorktree,
} from "@/lib/data/data-context";
import { hapticImpact, hapticSuccess, hapticWarning } from "@/lib/haptics";
import { attachmentLabel } from "@/lib/scratchpad-agent";
import type { AgentTab } from "@/lib/types";
import { catalogAgentById, useCatalog } from "@/lib/use-catalog";
import { useScratchpads } from "@/lib/use-scratchpads";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";
import { worktreeLabel, type WorktreeNode } from "@/lib/worktree-tree";
import { useThemeColors } from "@/lib/theme";

/** A worktree's view: nested child worktrees, then its agent tabs. Nests until
 *  a worktree has no children left — same recursion as the desktop sidebar. */
export default function WorktreeScreen() {
  const { worktreeId } = useLocalSearchParams<{ worktreeId: string }>();
  const worktree = useWorktree(worktreeId);
  const children = useChildWorktrees(worktreeId);
  const agentTabs = useAgentTabs(worktreeId);
  const { status } = useConnection();
  const insets = useSafeAreaInsets();
  const [launchOpen, setLaunchOpen] = useState(false);
  const { foreground } = useThemeColors();
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));

  const openLaunchSheet = useCallback(() => {
    hapticImpact();
    setLaunchOpen(true);
  }, []);
  const renderLaunchAgentButton = useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <LaunchAgentButton color={tintColor ?? foreground} onPress={openLaunchSheet} />
    ),
    [foreground, openLaunchSheet],
  );

  const empty = children.length === 0 && agentTabs.length === 0;

  return (
    <>
      <WorktreeHeader headerRight={renderLaunchAgentButton} status={status} worktree={worktree} />
      <WorktreeContents
        agentTabs={agentTabs}
        empty={empty}
        insetBottom={insets.bottom}
        worktreeId={worktreeId}
        worktreeNodes={children}
      />
      <WorktreeLaunchSheet onOpenChange={setLaunchOpen} open={launchOpen} worktree={worktree} />
    </>
  );
}

function WorktreeHeader({
  headerRight,
  status,
  worktree,
}: {
  headerRight: ({ tintColor }: { tintColor?: ColorValue }) => ReactNode;
  status: ReturnType<typeof useConnection>["status"];
  worktree: ReturnType<typeof useWorktree>;
}) {
  return (
    <Stack.Screen
      options={{
        title: worktree ? worktreeLabel(worktree) : "Worktree",
        headerRight: status === "paired" && worktree ? headerRight : undefined,
      }}
    />
  );
}

function WorktreeContents({
  agentTabs,
  empty,
  insetBottom,
  worktreeId,
  worktreeNodes,
}: {
  agentTabs: AgentTab[];
  empty: boolean;
  insetBottom: number;
  worktreeId: string;
  worktreeNodes: WorktreeNode[];
}) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: insetBottom + 24 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <WorktreesGroup nodes={worktreeNodes} />
      <AgentTabsGroup tabs={agentTabs} />
      <ScratchpadsGroup agentTabs={agentTabs} worktreeId={worktreeId} />
      {empty ? (
        <Text className="px-4 py-6 text-muted-foreground">No nested worktrees or agents here.</Text>
      ) : null}
    </ScrollView>
  );
}

function WorktreeLaunchSheet({
  onOpenChange,
  open,
  worktree,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  worktree: ReturnType<typeof useWorktree>;
}) {
  if (!worktree) return null;
  return (
    <LaunchSheet
      onOpenChange={onOpenChange}
      open={open}
      projectId={worktree.projectId}
      worktreeId={worktree.id}
    />
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

/**
 * The worktree's managed scratchpads, listed in the same row style as its
 * agents. Rendered only when the worktree has any — a worktree with no
 * scratchpad directory should not grow an empty section.
 */
function ScratchpadsGroup({
  agentTabs,
  worktreeId,
}: {
  agentTabs: AgentTab[];
  worktreeId: string;
}) {
  const { scratchpads } = useScratchpads(worktreeId);
  if (scratchpads.length === 0) return null;

  return (
    <NavGroup title="Scratchpads">
      {scratchpads.map((scratchpad) => (
        <NavRow
          key={scratchpad.id}
          onPress={() =>
            router.push({
              pathname: "/scratchpad/[scratchpadId]",
              params: {
                scratchpadId: scratchpad.id,
                filePath: scratchpad.filePath,
                title: scratchpad.title,
                worktreeId,
              },
            })
          }
          subtitle={attachmentLabel(scratchpad, agentTabs)}
          title={scratchpad.title}
        />
      ))}
    </NavGroup>
  );
}

/** The worktree's agent tabs section, or nothing when there are none. */
function AgentTabsGroup({ tabs }: { tabs: AgentTab[] }) {
  const [menuTab, setMenuTab] = useState<AgentTab | null>(null);
  if (tabs.length === 0) return null;

  return (
    <NavGroup title="Agents">
      <AgentTabRows tabs={tabs} onOpenActions={setMenuTab} />
      <AgentTabActionSheets menuTab={menuTab} onMenuTabChange={setMenuTab} />
    </NavGroup>
  );
}

/**
 * One row per session, led by the launching agent's icon. The catalog is
 * resolved once for the whole list — a per-row hook would refetch it per row.
 */
function AgentTabRows({
  tabs,
  onOpenActions,
}: {
  tabs: AgentTab[];
  onOpenActions: (tab: AgentTab) => void;
}) {
  const catalog = useCatalog();
  return tabs.map((tab) => (
    <NavRow
      key={tab.id}
      leading={
        <AgentIcon fallback="◆" icon={catalogAgentById(catalog, tab.agent)?.icon} size={22} />
      }
      onLongPress={() => onOpenActions(tab)}
      onPress={() =>
        router.push({
          pathname: "/chat/[tabId]",
          params: { agent: tab.agent, tabId: tab.id, worktreeId: tab.worktreeId },
        })
      }
      subtitle={tab.agent}
      title={tab.title}
      trailing={<AgentStatusDot status={tab.status} />}
    />
  ));
}

function AgentTabActionSheets({
  menuTab,
  onMenuTabChange,
}: {
  menuTab: AgentTab | null;
  onMenuTabChange: (tab: AgentTab | null) => void;
}) {
  const { clearAgent, renameAgent } = useAgentActions();
  const [clearingTabId, setClearingTabId] = useState<string | null>(null);
  const [renamingTab, setRenamingTab] = useState<AgentTab | null>(null);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);

  function clear(tab: AgentTab): void {
    if (clearingTabId) return;
    setClearingTabId(tab.id);
    void clearAgent(tab.id)
      .catch(() => Alert.alert("Couldn't clear agent", "The agent process could not be ended."))
      .finally(() => setClearingTabId(null));
  }

  async function rename(): Promise<void> {
    const nextTitle = title.trim();
    if (!renamingTab || !nextTitle) return;
    setRenaming(true);
    try {
      await renameAgent(renamingTab.id, nextTitle);
      hapticSuccess();
      setRenamingTab(null);
    } catch {
      hapticWarning();
      Alert.alert("Couldn't rename agent", "The agent process could not be renamed.");
    } finally {
      setRenaming(false);
    }
  }

  return (
    <>
      <BottomSheet onOpenChange={(open) => !open && onMenuTabChange(null)} open={!!menuTab}>
        <View className="gap-1">
          <Text className="text-lg font-semibold">{menuTab?.title}</Text>
          <Text className="text-sm text-muted-foreground">Agent session actions</Text>
        </View>
        <View className="mt-5 gap-3">
          <Button
            onPress={() => {
              if (!menuTab) return;
              setTitle(menuTab.title);
              setRenamingTab(menuTab);
              onMenuTabChange(null);
            }}
            variant="outline"
          >
            <Text>Rename</Text>
          </Button>
          <Button
            onPress={() => {
              if (!menuTab) return;
              clear(menuTab);
              onMenuTabChange(null);
            }}
            variant="destructive"
          >
            <Text>Clear</Text>
          </Button>
        </View>
      </BottomSheet>
      <BottomSheet onOpenChange={(open) => !open && setRenamingTab(null)} open={!!renamingTab}>
        <View className="gap-1">
          <Text className="text-lg font-semibold">Rename agent</Text>
          <Text className="text-sm text-muted-foreground">
            Choose a title for this agent session.
          </Text>
        </View>
        <View className="mt-5 gap-3">
          <Input
            autoFocus
            onChangeText={setTitle}
            onSubmitEditing={() => void rename()}
            value={title}
          />
          <View className="flex-row justify-end gap-2">
            <Button onPress={() => setRenamingTab(null)} size="sm" variant="outline">
              <Text>Cancel</Text>
            </Button>
            <Button disabled={!title.trim() || renaming} onPress={() => void rename()} size="sm">
              <Text>{renaming ? "Renaming..." : "Rename"}</Text>
            </Button>
          </View>
        </View>
      </BottomSheet>
    </>
  );
}
