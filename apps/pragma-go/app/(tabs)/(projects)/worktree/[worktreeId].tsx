import { router, Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  View,
  type ColorValue,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { LaunchAgentButton } from "@/components/LaunchAgentButton";
import { LaunchSheet } from "@/components/LaunchSheet";
import { CommitAndPrSheet } from "@/components/CommitAndPrSheet";
import { FileExplorer } from "@/components/FileExplorer";
import { IconSymbol } from "@/components/IconSymbol";
import { NavGroup, NavRow } from "@/components/NavRow";
import { RenameTabSheet } from "@/components/RenameTabSheet";
import { ScriptsMenuButton } from "@/components/ScriptsMenuButton";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { FanoutMembershipGroup, WorktreeGroup } from "@/components/WorktreeGroup";
import { useConnection } from "@/lib/connection-context";
import {
  useAgentActions,
  useAgentTabs,
  useChildWorktrees,
  useProjectRootPath,
  useTerminalActions,
  useTerminalTabs,
  useWorktree,
} from "@/lib/data/data-context";
import { hapticImpact, hapticSuccess, hapticWarning } from "@/lib/haptics";
import { confirmPortForward } from "@/lib/confirm-port-forward";
import { attachmentLabel } from "@/lib/scratchpad-agent";
import type { AgentTab, TerminalTab } from "@/lib/types";
import { useOpenPorts } from "@/lib/use-open-ports";
import type { OpenPort } from "@pragma-sh/sdk";
import { catalogAgentById, useCatalog } from "@/lib/use-catalog";
import { useCommitAndPr, type CommitAndPr } from "@/lib/use-commit-and-pr";
import { useScratchpads } from "@/lib/use-scratchpads";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";
import { worktreeLabel, type WorktreeNode } from "@/lib/worktree-tree";
import { useThemeColors } from "@/lib/theme";
import { errorText } from "@/lib/utils";

/** A worktree's view: nested child worktrees, then its agent tabs. Nests until
 *  a worktree has no children left — same recursion as the desktop sidebar. */
export default function WorktreeScreen() {
  const { worktreeId } = useLocalSearchParams<{ worktreeId: string }>();
  const worktree = useWorktree(worktreeId);
  const children = useChildWorktrees(worktreeId);
  const agentTabs = useAgentTabs(worktreeId);
  const terminalTabs = useTerminalTabs(worktreeId);
  const ports = useOpenPorts(worktreeId);
  const commitAndPr = useCommitAndPr(worktreeId, worktree?.path);
  const { commitOpen, setCommitOpen, openCommitSheet } = useCommitSheet(commitAndPr);
  const { status } = useConnection();
  const insets = useSafeAreaInsets();
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  const [launchOpen, setLaunchOpen] = useState(false);
  const openLaunchSheet = useCallback(() => {
    hapticImpact();
    setLaunchOpen(true);
  }, []);
  const renderHeaderActions = useHeaderActions(
    commitAndPr,
    openCommitSheet,
    openLaunchSheet,
    worktreeId,
  );

  return (
    <>
      <WorktreeHeader headerRight={renderHeaderActions} status={status} worktree={worktree} />
      <WorktreeContents
        agentTabs={agentTabs}
        commitAndPr={commitAndPr}
        empty={isEmptyWorktree(children, agentTabs, terminalTabs)}
        insetBottom={insets.bottom}
        onLaunchAgent={openLaunchSheet}
        ports={ports}
        projectId={projectIdOf(worktree)}
        root={pairedRoot(status, worktree)}
        terminalTabs={terminalTabs}
        worktreeId={worktreeId}
        worktreeNodes={children}
      />
      <WorktreeLaunchSheet onOpenChange={setLaunchOpen} open={launchOpen} worktree={worktree} />
      <CommitAndPrSheet
        flow={commitAndPr}
        onOpenChange={setCommitOpen}
        open={commitOpen}
        worktreeName={worktreeName(worktree)}
      />
    </>
  );
}

type WorktreeValue = ReturnType<typeof useWorktree>;

/**
 * The header's right-hand actions. Keyed on the three fields the commit action
 * reads rather than the whole flow, which is a new object every render — the
 * header options would otherwise be replaced on every one.
 */
function useHeaderActions(
  flow: CommitAndPr,
  onCommit: () => void,
  onLaunch: () => void,
  worktreeId: string,
) {
  const { foreground } = useThemeColors();
  const { phase, githubReady, hasChanges } = flow;
  const commitState = useMemo(
    () => ({ phase, githubReady, hasChanges }),
    [githubReady, hasChanges, phase],
  );
  return useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <WorktreeHeaderActions
        color={tintColor ?? foreground}
        flow={commitState}
        onCommit={onCommit}
        onLaunch={onLaunch}
        worktreeId={worktreeId}
      />
    ),
    [commitState, foreground, onCommit, onLaunch, worktreeId],
  );
}

/** Terminals and agents are always offered, so "empty" is only about what already exists. */
function isEmptyWorktree(
  children: WorktreeNode[],
  agentTabs: AgentTab[],
  terminalTabs: TerminalTab[],
): boolean {
  return children.length === 0 && agentTabs.length === 0 && terminalTabs.length === 0;
}

function projectIdOf(worktree: WorktreeValue): string {
  return worktree?.projectId ?? "";
}

/** The worktree's host path, once paired and loaded; the file explorer needs it. */
function pairedRoot(
  status: ReturnType<typeof useConnection>["status"],
  worktree: WorktreeValue,
): string | undefined {
  return status === "paired" ? worktree?.path : undefined;
}

function worktreeName(worktree: WorktreeValue): string {
  return worktree ? worktreeLabel(worktree) : "this worktree";
}

/**
 * Whether the Commit & PR sheet is open. The run is the host's, and the sheet
 * is closed while it goes: the header action is the progress. It comes back on
 * its own once there is something to act on — the pull request draft, or a
 * failure worth reading.
 */
function useCommitSheet(flow: CommitAndPr) {
  const [commitOpen, setCommitOpen] = useState(false);
  const openCommitSheet = useCallback(() => {
    hapticImpact();
    setCommitOpen(true);
  }, []);
  const settled = flow.phase === "review" || flow.phase === "failed";
  useEffect(() => {
    if (settled) setCommitOpen(true);
  }, [settled]);
  return { commitOpen, setCommitOpen, openCommitSheet };
}

/**
 * Header right, in the order the plan calls for: commit, scripts, then launch.
 * All are the same size and hit target, so a long worktree title truncates
 * rather than pushing any off the edge.
 */
function WorktreeHeaderActions({
  color,
  flow,
  onCommit,
  onLaunch,
  worktreeId,
}: {
  color: ColorValue;
  flow: CommitActionState;
  onCommit: () => void;
  onLaunch: () => void;
  worktreeId: string;
}) {
  return (
    <View className="flex-row items-center gap-4">
      <CommitActionButton color={color} flow={flow} onPress={onCommit} />
      <ScriptsMenuButton color={color} worktreeId={worktreeId} />
      <LaunchAgentButton color={color} onPress={onLaunch} />
    </View>
  );
}

/**
 * Two things block the flow before it starts: a host with no GitHub token
 * cannot push or open a pull request, and a clean worktree has nothing to
 * commit. Both are the desktop's conditions. Unknown blocks neither.
 */
function isCommitBlocked(flow: CommitActionState): boolean {
  return flow.githubReady === false || flow.hasChanges === false;
}

/** What the header's Commit & PR action reads from the flow. */
type CommitActionState = Pick<CommitAndPr, "phase" | "githubReady" | "hasChanges">;

/** The Commit & PR header action; a spinner while the host's run is going. */
function CommitActionButton({
  color,
  flow,
  onPress,
}: {
  color: ColorValue;
  flow: CommitActionState;
  onPress: () => void;
}) {
  const working = flow.phase === "running";
  const blocked = isCommitBlocked(flow);
  const disabled = working || blocked;
  return (
    <Pressable
      accessibilityLabel={commitActionLabel({
        githubReady: flow.githubReady,
        hasChanges: flow.hasChanges,
        working,
      })}
      accessibilityRole="button"
      accessibilityState={{ busy: working, disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={blocked ? { opacity: 0.4 } : undefined}
    >
      {working ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <IconSymbol color={color} fallback="⑂" name="arrow.triangle.pull" size={22} />
      )}
    </Pressable>
  );
}

/** What the header action says it is, including why it cannot be used. */
function commitActionLabel({
  githubReady,
  hasChanges,
  working,
}: {
  githubReady: boolean | null;
  hasChanges: boolean | null;
  working: boolean;
}): string {
  if (working) return "Committing…";
  if (githubReady === false) return "Sign in to GitHub to commit and open a pull request";
  if (hasChanges === false) return "Nothing to commit";
  return "Commit and open a pull request";
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
  commitAndPr,
  empty,
  insetBottom,
  onLaunchAgent,
  ports,
  projectId,
  root,
  terminalTabs,
  worktreeId,
  worktreeNodes,
}: {
  agentTabs: AgentTab[];
  commitAndPr: CommitAndPr;
  empty: boolean;
  insetBottom: number;
  onLaunchAgent: () => void;
  ports: OpenPort[];
  projectId: string;
  /** The worktree's host path, once paired and loaded; the file explorer needs it. */
  root: string | undefined;
  terminalTabs: TerminalTab[];
  worktreeId: string;
  worktreeNodes: WorktreeNode[];
}) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: insetBottom + 24 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <LinkedPullRequest flow={commitAndPr} />
      <FanoutMembershipGroup worktreeId={worktreeId} />
      <WorktreeGroup nodes={worktreeNodes} title="Worktrees" />
      <TerminalsGroup tabs={terminalTabs} worktreeId={worktreeId} />
      <PortsGroup ports={ports} projectId={projectId} />
      <AgentTabsGroup onLaunch={onLaunchAgent} tabs={agentTabs} />
      <ScratchpadsGroup agentTabs={agentTabs} worktreeId={worktreeId} />
      {empty ? (
        <Text className="px-4 py-6 text-muted-foreground">
          Nothing running here yet. Open a terminal or launch an agent.
        </Text>
      ) : null}
      {root ? <FileExplorer root={root} worktreeId={worktreeId} /> : null}
    </ScrollView>
  );
}

/** Open listeners shown directly below terminals, matching desktop inventory. */
function PortsGroup({ ports, projectId }: { ports: OpenPort[]; projectId: string }) {
  const { client } = useConnection();
  const [forwarding, setForwarding] = useState<string | null>(null);
  // The state above lags a render; the ref is what guards against two confirmed
  // taps racing the same forward through (stale closure during the await).
  const busyRef = useRef<string | null>(null);
  if (!client || !projectId || ports.length === 0) return null;

  const open = async (port: OpenPort): Promise<void> => {
    const key = `${port.tabId}:${port.port}`;
    if (!(await confirmIdleForward(busyRef, port))) return;
    busyRef.current = key;
    setForwarding(key);
    hapticImpact();
    try {
      const result = await client.ports.forward({ projectId, port });
      await Linking.openURL(result.url);
      hapticSuccess();
    } catch (error) {
      hapticWarning();
      Alert.alert(
        "Couldn't forward port",
        errorText(error, "The host could not expose this port."),
      );
    } finally {
      busyRef.current = null;
      setForwarding(null);
    }
  };

  return (
    <NavGroup title="Ports">
      {ports.map((port) => {
        const key = `${port.tabId}:${port.port}`;
        return (
          <NavRow
            key={key}
            onPress={() => void open(port)}
            subtitle={`${port.process} (PID ${port.pid})`}
            title={forwarding === key ? `Forwarding ${port.port}...` : String(port.port)}
          />
        );
      })}
    </NavGroup>
  );
}

/**
 * Confirms a forward only while none is in flight — checked again after the
 * prompt, since another tap may have started one while it was open.
 */
async function confirmIdleForward(
  busyRef: { current: string | null },
  port: OpenPort,
): Promise<boolean> {
  if (busyRef.current) return false;
  return (await confirmPortForward(port)) && !busyRef.current;
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

/**
 * The branch's pull request, when it has one.
 *
 * Opened with the platform link handler on the canonical
 * `https://github.com/owner/repo/pull/number` GitHub itself reports — so the OS
 * routes it to the GitHub app when the user has one, and to a browser when they
 * do not. There is no `github://` scheme to invent.
 */
function LinkedPullRequest({ flow }: { flow: CommitAndPr }) {
  const pullRequest = flow.pullRequest;
  if (!pullRequest) return null;
  return (
    <NavGroup title="Pull request">
      <NavRow
        onPress={() => void Linking.openURL(pullRequest.url)}
        subtitle={PULL_REQUEST_STATE_LABEL[pullRequest.state]}
        title={`#${pullRequest.number} ${pullRequest.title}`}
      />
    </NavGroup>
  );
}

/** Merged reads differently from closed, so the labels keep them apart. */
const PULL_REQUEST_STATE_LABEL = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
} as const;

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

/**
 * The worktree's ordinary terminals, with a row that opens another.
 *
 * Always rendered, unlike the other sections: "there is no terminal here" is
 * exactly when the user wants to open one. Agent sessions are deliberately
 * absent — they live under Agents, and one session with two close buttons in
 * two sections is how a tap ends the wrong thing.
 */
function TerminalsGroup({ tabs, worktreeId }: { tabs: TerminalTab[]; worktreeId: string }) {
  const { openTerminal } = useTerminalActions();
  const { status } = useConnection();
  const [opening, setOpening] = useState(false);
  const [menuTab, setMenuTab] = useState<TerminalTab | null>(null);

  if (status !== "paired") return null;

  const open = (): void => {
    if (opening) return;
    setOpening(true);
    hapticImpact();
    void openTerminal(worktreeId)
      .then((tabId) => {
        router.push({ pathname: "/terminal/[tabId]", params: { tabId, worktreeId } });
        return undefined;
      })
      .catch(() => Alert.alert("Couldn't open terminal", "The host could not start a shell here."))
      .finally(() => setOpening(false));
  };

  return (
    <NavGroup title="Terminals">
      {tabs.map((tab) => (
        <NavRow
          key={tab.id}
          onLongPress={() => setMenuTab(tab)}
          onPress={() =>
            router.push({
              pathname: "/terminal/[tabId]",
              params: { tabId: tab.id, title: tab.title, worktreeId: tab.worktreeId },
            })
          }
          title={tab.title}
        />
      ))}
      <NavRow
        chevron={false}
        onPress={open}
        title={opening ? "Opening terminal…" : "New terminal"}
      />
      <TerminalTabActionSheets menuTab={menuTab} onMenuTabChange={setMenuTab} />
    </NavGroup>
  );
}

/**
 * Long-press actions for one terminal: rename it, or end it.
 *
 * Deliberately the same shape as the agent sheet — a tab is a tab, and having
 * one kind of session renamed from a sheet and the other from somewhere else is
 * how a user learns two gestures for one idea. Ending is not a local dismissal:
 * the process stops and the tab disappears on the desktop too, which the sheet
 * says before the tap rather than after it.
 */
function TerminalTabActionSheets({
  menuTab,
  onMenuTabChange,
}: {
  menuTab: TerminalTab | null;
  onMenuTabChange: (tab: TerminalTab | null) => void;
}) {
  const { closeTerminal, renameTab } = useTerminalActions();
  const [closing, setClosing] = useState(false);
  const [renamingTab, setRenamingTab] = useState<TerminalTab | null>(null);

  function close(tab: TerminalTab): void {
    if (closing) return;
    setClosing(true);
    void closeTerminal(tab.id)
      .then(() => {
        hapticSuccess();
        return undefined;
      })
      .catch(() => {
        hapticWarning();
        Alert.alert("Couldn't close terminal", "The session could not be ended.");
      })
      .finally(() => setClosing(false));
  }

  return (
    <>
      <BottomSheet onOpenChange={(open) => !open && onMenuTabChange(null)} open={!!menuTab}>
        <View className="gap-1">
          <Text className="text-lg font-semibold">{menuTab?.title}</Text>
          <Text className="text-sm text-muted-foreground">
            Closing ends this session and removes it everywhere, including on your computer.
          </Text>
        </View>
        <View className="mt-5 gap-3">
          <Button
            onPress={() => {
              if (!menuTab) return;
              setRenamingTab(menuTab);
              onMenuTabChange(null);
            }}
            variant="outline"
          >
            <Text>Rename</Text>
          </Button>
          <Button
            disabled={closing}
            onPress={() => {
              if (!menuTab) return;
              close(menuTab);
              onMenuTabChange(null);
            }}
            variant="destructive"
          >
            <Text>{closing ? "Closing…" : "Close terminal"}</Text>
          </Button>
        </View>
      </BottomSheet>
      <RenameTabSheet
        description="Choose a title for this terminal."
        errorTitle="Couldn't rename terminal"
        heading="Rename terminal"
        onDone={() => setRenamingTab(null)}
        rename={renameTab}
        tab={renamingTab}
      />
    </>
  );
}

/**
 * The worktree's agent tabs, with a row that launches another.
 *
 * Always rendered while paired, like Terminals: "no agent here yet" is exactly
 * when the user wants to start one. The row opens the same launch sheet as the
 * header's + button.
 */
function AgentTabsGroup({ onLaunch, tabs }: { onLaunch: () => void; tabs: AgentTab[] }) {
  const { status } = useConnection();
  const [menuTab, setMenuTab] = useState<AgentTab | null>(null);
  if (status !== "paired") return null;

  return (
    <NavGroup title="Agents">
      <AgentTabRows tabs={tabs} onOpenActions={setMenuTab} />
      <NavRow chevron={false} onPress={onLaunch} title="New agent" />
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
  const { clearAgent, renameTab } = useAgentActions();
  const [clearingTabId, setClearingTabId] = useState<string | null>(null);
  const [renamingTab, setRenamingTab] = useState<AgentTab | null>(null);

  function clear(tab: AgentTab): void {
    if (clearingTabId) return;
    setClearingTabId(tab.id);
    void clearAgent(tab.id)
      .catch(() => Alert.alert("Couldn't clear agent", "The agent process could not be ended."))
      .finally(() => setClearingTabId(null));
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
      <RenameTabSheet
        description="Choose a title for this agent session."
        errorTitle="Couldn't rename agent"
        heading="Rename agent"
        onDone={() => setRenamingTab(null)}
        rename={renameTab}
        tab={renamingTab}
      />
    </>
  );
}
