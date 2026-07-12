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
  const { tabId } = params;
  const tab = useAgentTab(tabId);
  const { markAgentSeen } = useAgentActions();
  // Prefer launch-time params so a freshly launched session attaches before the
  // workspace snapshot catches up; fall back to the resolved tab afterwards.
  const worktreeId = tab?.worktreeId ?? params.worktreeId ?? "";
  const { rows, attention, phase, send, interrupt, decide, answer } = useAgentConnection({
    agent: tab?.agent ?? params.agent ?? "",
    tabId,
    worktreeId,
  });
  useFocusEffect(
    useCallback(() => {
      if (tab?.status === "done") markAgentSeen(tabId);
    }, [markAgentSeen, tab?.status, tabId]),
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: displayTabTitle(tab?.title),
          headerLargeTitle: false,
          headerTitleAlign: "center",
          headerRight: renderNewWorktreeButton,
          // oxlint-disable-next-line react/no-unstable-nested-components -- React Navigation headerLeft render callback, not a render-time component.
          headerLeft: ({ tintColor }) => (
            <ChatHeaderBackButton color={tintColor ?? "black"} worktreeId={worktreeId} />
          ),
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-background"
        keyboardVerticalOffset={composerKeyboardOffset}
      >
        <SafeAreaView className="flex-1" edges={["bottom"]}>
          <MessageList phase={phase} rows={rows} />
          {attention ? (
            <AttentionDock onAnswer={answer} onDecide={decide} request={attention} />
          ) : null}
          <Composer isRunning={tab?.status === "running"} onInterrupt={interrupt} onSend={send} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </>
  );
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
