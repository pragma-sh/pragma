import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, ScrollView, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  useWorktree,
} from "@/lib/data/data-context";
import { hapticImpact, hapticSuccess, hapticWarning } from "@/lib/haptics";
import type { AgentTab } from "@/lib/types";
import { worktreeLabel, type WorktreeNode } from "@/lib/worktree-tree";

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

  const empty = children.length === 0 && agentTabs.length === 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: worktree ? worktreeLabel(worktree) : "Worktree",
          headerRight: status === "paired" && worktree ? renderLaunchAgentButton : undefined,
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
      {worktree ? (
        <LaunchSheet
          onOpenChange={setLaunchOpen}
          open={launchOpen}
          projectId={worktree.projectId}
          worktreeId={worktree.id}
        />
      ) : null}
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
  const { clearAgent, renameAgent } = useAgentActions();
  const [clearingTabId, setClearingTabId] = useState<string | null>(null);
  const [menuTab, setMenuTab] = useState<AgentTab | null>(null);
  const [renamingTab, setRenamingTab] = useState<AgentTab | null>(null);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  if (tabs.length === 0) return null;

  const clear = (tab: AgentTab): void => {
    if (clearingTabId) return;
    setClearingTabId(tab.id);
    void clearAgent(tab.id)
      .catch(() => Alert.alert("Couldn't clear agent", "The agent process could not be ended."))
      .finally(() => setClearingTabId(null));
  };

  const openRename = (tab: AgentTab): void => {
    setTitle(tab.title);
    setRenamingTab(tab);
  };

  const rename = (): void => {
    const nextTitle = title.trim();
    if (!renamingTab || !nextTitle) return;
    setRenaming(true);
    void renameAgent(renamingTab.id, nextTitle)
      .then(() => {
        hapticSuccess();
        setRenamingTab(null);
        return undefined;
      })
      .catch(() => {
        hapticWarning();
        Alert.alert("Couldn't rename agent", "The agent process could not be renamed.");
      })
      .finally(() => setRenaming(false));
  };

  return (
    <NavGroup title="Agents">
      {tabs.map((tab) => (
        <NavRow
          key={tab.id}
          onLongPress={() => setMenuTab(tab)}
          onPress={() => router.push({ pathname: "/chat/[tabId]", params: { tabId: tab.id } })}
          subtitle={tab.agent}
          title={tab.title}
          trailing={<AgentStatusDot status={tab.status} />}
        />
      ))}
      <BottomSheet onOpenChange={(open) => !open && setMenuTab(null)} open={!!menuTab}>
        <View className="gap-1">
          <Text className="text-lg font-semibold">{menuTab?.title}</Text>
          <Text className="text-sm text-muted-foreground">Agent session actions</Text>
        </View>
        <View className="mt-5 gap-3">
          <Button
            onPress={() => {
              if (!menuTab) return;
              openRename(menuTab);
              setMenuTab(null);
            }}
            variant="outline"
          >
            <Text>Rename</Text>
          </Button>
          <Button
            onPress={() => {
              if (!menuTab) return;
              clear(menuTab);
              setMenuTab(null);
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
          <Input autoFocus onChangeText={setTitle} onSubmitEditing={rename} value={title} />
          <View className="flex-row justify-end gap-2">
            <Button onPress={() => setRenamingTab(null)} size="sm" variant="outline">
              <Text>Cancel</Text>
            </Button>
            <Button disabled={!title.trim() || renaming} onPress={rename} size="sm">
              <Text>{renaming ? "Renaming..." : "Rename"}</Text>
            </Button>
          </View>
        </View>
      </BottomSheet>
    </NavGroup>
  );
}
