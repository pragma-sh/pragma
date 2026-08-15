import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { renderNewWorktreeButton } from "@/components/NewWorktreeButton";
import { WorktreeBackButton } from "@/components/WorktreeBackButton";
import { AttentionDock } from "@/components/chat/AttentionDock";
import { Composer, composerKeyboardOffset } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { ScratchpadPill } from "@/components/chat/ScratchpadPill";
import {
  useAgentActions,
  useAgentTab,
  useProjectRootPath,
  useWorktree,
} from "@/lib/data/data-context";
import { useThemeColors } from "@/lib/theme";
import { useAgentConnection } from "@/lib/use-agent-connection";
import { agentSessionTitle, DEFAULT_TAB_TITLE } from "@/lib/tab-title";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/**
 * Live chat surface for one agent tab. Attaches to the running agent on focus,
 * streams its transcript, docks any pending command/question, and sends
 * interjections + interrupts back on the same channel.
 */
export default function ChatScreen() {
  const params = useLocalSearchParams<{
    tabId: string;
    agent?: string;
    initialMessage?: string;
    initialMessageTs?: string;
    title?: string;
    worktreeId?: string;
  }>();
  return <LiveChat params={params} />;
}

type ChatParams = {
  tabId: string;
  agent?: string;
  initialMessage?: string;
  initialMessageTs?: string;
  title?: string;
  worktreeId?: string;
};

function LiveChat({ params }: { params: ChatParams }) {
  const { tabId } = params;
  const tab = useAgentTab(tabId);
  return <ChatSession params={params} tab={tab} />;
}

function ChatSession({ params, tab }: { params: ChatParams; tab: ReturnType<typeof useAgentTab> }) {
  const details = chatDetails(params, tab);
  const worktree = useWorktree(details.worktreeId);
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  // Prefer launch-time params so a freshly launched session attaches before the
  // workspace snapshot catches up; fall back to the resolved tab afterwards.
  const { rows, attention, phase, send, interrupt, decide, answer } = useAgentConnection({
    agent: details.agent,
    initialMessage: params.initialMessage,
    initialMessageTs: Number(params.initialMessageTs) || undefined,
    tabId: details.tabId,
    worktreeId: details.worktreeId,
  });
  return (
    <>
      <ChatNavigation title={details.title} worktreeId={details.worktreeId} />
      <MarkDoneAgent status={details.status} tabId={details.tabId} />
      <ChatBody
        attention={attention}
        onAnswer={answer}
        onDecide={decide}
        onInterrupt={interrupt}
        onSend={send}
        phase={phase}
        rows={rows}
        running={details.status === "running"}
        tabId={details.tabId}
        worktreeId={details.worktreeId}
      />
    </>
  );
}

function chatDetails(params: ChatParams, tab: ReturnType<typeof useAgentTab>) {
  return {
    agent: resolvedAgent(tab, params.agent),
    status: tab && tab.status,
    tabId: params.tabId,
    title: chatTitle(tab?.title, params.title),
    worktreeId: resolvedWorktreeId(tab, params.worktreeId),
  };
}

function chatTitle(
  tabTitle: string | undefined,
  launchTitle: string | undefined,
): string | undefined {
  return tabTitle && tabTitle !== DEFAULT_TAB_TITLE ? tabTitle : (launchTitle ?? tabTitle);
}

function resolvedAgent(tab: ReturnType<typeof useAgentTab>, agent: string | undefined): string {
  return agent ?? tab?.agent ?? "";
}

function resolvedWorktreeId(
  tab: ReturnType<typeof useAgentTab>,
  worktreeId: string | undefined,
): string {
  return worktreeId ?? tab?.worktreeId ?? "";
}

function ChatNavigation({ title, worktreeId }: { title: string | undefined; worktreeId: string }) {
  const { foreground } = useThemeColors();
  return (
    <Stack.Screen
      options={{
        title: agentSessionTitle(title),
        headerLargeTitle: false,
        headerTitleAlign: "center",
        headerRight: renderNewWorktreeButton,
        // oxlint-disable-next-line react/no-unstable-nested-components -- React Navigation header render callback.
        headerLeft: ({ tintColor }) => (
          <WorktreeBackButton color={tintColor ?? foreground} worktreeId={worktreeId} />
        ),
      }}
    />
  );
}

interface ChatBodyProps {
  attention: ReturnType<typeof useAgentConnection>["attention"];
  onAnswer: ReturnType<typeof useAgentConnection>["answer"];
  onDecide: ReturnType<typeof useAgentConnection>["decide"];
  onInterrupt: ReturnType<typeof useAgentConnection>["interrupt"];
  onSend: ReturnType<typeof useAgentConnection>["send"];
  phase: ReturnType<typeof useAgentConnection>["phase"];
  rows: ReturnType<typeof useAgentConnection>["rows"];
  running: boolean;
  tabId: string;
  worktreeId: string;
}

function ChatBody({
  attention,
  onAnswer,
  onDecide,
  onInterrupt,
  onSend,
  phase,
  rows,
  running,
  tabId,
  worktreeId,
}: ChatBodyProps) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-background"
      keyboardVerticalOffset={composerKeyboardOffset}
    >
      <SafeAreaView className="flex-1" edges={["bottom"]}>
        <MessageList phase={phase} rows={rows} />
        {attention ? (
          <AttentionDock onAnswer={onAnswer} onDecide={onDecide} request={attention} />
        ) : null}
        <ScratchpadPill tabId={tabId} worktreeId={worktreeId} />
        <Composer isRunning={running} onInterrupt={onInterrupt} onSend={onSend} />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function MarkDoneAgent({
  status,
  tabId,
}: {
  status: NonNullable<ReturnType<typeof useAgentTab>>["status"] | undefined;
  tabId: string;
}) {
  const { markAgentSeen } = useAgentActions();
  useFocusEffect(
    useCallback(() => {
      if (status === "done") markAgentSeen(tabId);
    }, [markAgentSeen, status, tabId]),
  );
  return null;
}
