import { base64ToBytes } from "@pragma/sdk";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { TerminalKeyBar, controlByte } from "@/components/terminal/TerminalKeyBar";
import { TerminalWebView, type TerminalViewHandle } from "@/components/terminal/TerminalWebView";
import { useProjectRootPath, useTerminalTab, useWorktree } from "@/lib/data/data-context";
import { useTerminalSession, type TerminalStatus } from "@/lib/use-terminal-session";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";

/**
 * One terminal session, full screen and outside the bottom tabs.
 *
 * Attaching here joins the session the host is already running — it does not
 * start a shell — so leaving simply detaches: the process keeps running, and
 * the desktop keeps its own view of it. Ending a session is the explicit close
 * action on the terminal row, never a back gesture.
 */
export default function TerminalScreen() {
  const { tabId, title, worktreeId } = useLocalSearchParams<{
    tabId: string;
    title?: string;
    worktreeId?: string;
  }>();
  const tab = useTerminalTab(tabId);
  const worktree = useWorktree(worktreeId ?? tab?.worktreeId ?? "");
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  const renderer = useRef<TerminalViewHandle>(null);
  const [attached, setAttached] = useState(false);
  const [controlArmed, setControlArmed] = useState(false);
  const [shellTitle, setShellTitle] = useState<string | null>(null);

  // Attach only while the screen is in front: a backgrounded terminal should
  // not hold the session's viewport, and the host expires the lease if this
  // app is suspended before it can release.
  useFocusEffect(
    useCallback(() => {
      setAttached(true);
      return () => setAttached(false);
    }, []),
  );

  const session = useTerminalSession(
    tabId,
    {
      onOutput: (dataBase64) => renderer.current?.send({ type: "write", dataBase64 }),
      onReset: () => renderer.current?.send({ type: "reset" }),
      onTitle: setShellTitle,
    },
    { attached },
  );

  const send = useCallback(
    (bytes: Uint8Array) => {
      session.write(bytes);
    },
    [session],
  );

  const handleInput = useCallback(
    (dataBase64: string) => {
      const bytes = base64ToBytes(dataBase64);
      if (!controlArmed) {
        send(bytes);
        return;
      }
      // Sticky Ctrl: a touch screen has no chord to hold, so the next printable
      // key consumes the modifier. A key with no control form sends unchanged
      // rather than being swallowed.
      setControlArmed(false);
      const control = bytes.length === 1 ? controlByte(String.fromCharCode(bytes[0]!)) : null;
      send(control === null ? bytes : new Uint8Array([control]));
    },
    [controlArmed, send],
  );

  const handlePaste = useCallback(() => {
    void Clipboard.getStringAsync().then((text) => {
      // Through the renderer, not as raw input: `paste` honours the program's
      // bracketed-paste mode, which is what stops a multi-line paste from
      // running each line as its own command.
      if (text) renderer.current?.send({ type: "paste", text });
      return undefined;
    });
  }, []);

  const label = shellTitle ?? tab?.title ?? title ?? "Terminal";

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
      <Stack.Screen options={{ title: label }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <StatusLine error={session.error} exitCode={session.exitCode} status={session.status} />
        <View className="flex-1">
          <TerminalWebView
            onInput={handleInput}
            onLink={(url) => void Linking.openURL(url)}
            onReady={() => renderer.current?.send({ type: "focus" })}
            onResize={session.resize}
            ref={renderer}
          />
        </View>
        <TerminalKeyBar
          controlArmed={controlArmed}
          onPaste={handlePaste}
          onSend={send}
          onToggleControl={() => setControlArmed((armed) => !armed)}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * The connection state, above the terminal.
 *
 * An exited session says so and stays on screen: the output explaining why a
 * command failed is the reason to be here, and silently respawning the shell
 * would replace it with an empty prompt.
 */
function StatusLine({
  error,
  exitCode,
  status,
}: {
  error: string | null;
  exitCode: number | null;
  status: TerminalStatus;
}) {
  if (status === "live") return null;
  const message =
    status === "exited"
      ? `Session ended${exitCode === null ? "" : ` (exit ${exitCode})`}`
      : status === "unavailable"
        ? (error ?? "This terminal is not available")
        : "Connecting…";
  return (
    <View className="border-b border-border bg-muted px-4 py-2">
      <Text className="text-xs text-muted-foreground">{message}</Text>
    </View>
  );
}
