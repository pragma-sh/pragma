import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { KeyboardAvoidingView, Platform, Pressable, type ColorValue } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { IconSymbol } from "@/components/IconSymbol";
import { renderNewWorktreeButton } from "@/components/NewWorktreeButton";
import { AttentionDock } from "@/components/chat/AttentionDock";
import { Composer, composerKeyboardOffset } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { Text } from "@/components/ui/text";
import { useAgentActions, useAgentTab, useWorktree } from "@/lib/data/data-context";
import { useAgentConnection } from "@/lib/use-agent-connection";
import { displayTabTitle } from "@/lib/tab-title";
import { worktreeLabel } from "@/lib/worktree-tree";

/**
 * Live chat surface for one agent tab. Attaches to the running agent on focus,
 * streams its transcript, docks any pending command/question, and sends
 * interjections + interrupts back on the same channel.
 */
export default function ChatScreen() {
  const params = useLocalSearchParams<{ tabId: string; agent?: string; worktreeId?: string }>();
  return <LiveChat params={params} />;
}

function LiveChat({ params }: { params: { tabId: string; agent?: string; worktreeId?: string } }) {
  const { tabId } = params;
  const tab = useAgentTab(tabId);
  return <ChatSession params={params} tab={tab} />;
}

function ChatSession({
  params,
  tab,
}: {
  params: { tabId: string; agent?: string; worktreeId?: string };
  tab: ReturnType<typeof useAgentTab>;
}) {
  const details = chatDetails(params, tab);
  // Prefer launch-time params so a freshly launched session attaches before the
  // workspace snapshot catches up; fall back to the resolved tab afterwards.
  const { rows, attention, phase, send, interrupt, decide, answer } = useAgentConnection({
    agent: details.agent,
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
      />
    </>
  );
}

function chatDetails(
  params: { tabId: string; agent?: string; worktreeId?: string },
  tab: ReturnType<typeof useAgentTab>,
) {
  return {
    agent: resolvedAgent(tab, params.agent),
    status: tab && tab.status,
    tabId: params.tabId,
    title: tab && tab.title,
    worktreeId: resolvedWorktreeId(tab, params.worktreeId),
  };
}

function resolvedAgent(tab: ReturnType<typeof useAgentTab>, agent: string | undefined): string {
  return tab?.agent ?? agent ?? "";
}

function resolvedWorktreeId(
  tab: ReturnType<typeof useAgentTab>,
  worktreeId: string | undefined,
): string {
  return tab?.worktreeId ?? worktreeId ?? "";
}

function ChatNavigation({ title, worktreeId }: { title: string | undefined; worktreeId: string }) {
  return (
    <Stack.Screen
      options={{
        title: displayTabTitle(title),
        headerLargeTitle: false,
        headerTitleAlign: "center",
        headerRight: renderNewWorktreeButton,
        // oxlint-disable-next-line react/no-unstable-nested-components -- React Navigation header render callback.
        headerLeft: ({ tintColor }) => (
          <ChatHeaderBackButton color={tintColor ?? "black"} worktreeId={worktreeId} />
        ),
      }}
    />
  );
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
}: {
  attention: ReturnType<typeof useAgentConnection>["attention"];
  onAnswer: ReturnType<typeof useAgentConnection>["answer"];
  onDecide: ReturnType<typeof useAgentConnection>["decide"];
  onInterrupt: ReturnType<typeof useAgentConnection>["interrupt"];
  onSend: ReturnType<typeof useAgentConnection>["send"];
  phase: ReturnType<typeof useAgentConnection>["phase"];
  rows: ReturnType<typeof useAgentConnection>["rows"];
  running: boolean;
}) {
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

/** Header back button: shows the worktree being returned to, not the route segment name. */
function ChatHeaderBackButton({ color, worktreeId }: { color: ColorValue; worktreeId: string }) {
  const worktree = useWorktree(worktreeId);
  const label = worktree ? worktreeLabel(worktree) : "Back";
  return (
    <Pressable
      accessibilityLabel={`Back to ${label}`}
      accessibilityRole="button"
      className="h-9 flex-row items-center active:opacity-60"
      hitSlop={8}
      onPress={() => router.back()}
    >
      <IconSymbol color={color} fallback="‹" name="chevron.left" size={22} />
      <Text className="text-base" numberOfLines={1} style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}
