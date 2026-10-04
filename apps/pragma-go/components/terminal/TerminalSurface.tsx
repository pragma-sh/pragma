import { base64ToBytes } from "@pragma-sh/sdk";
import { useCallback, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, View } from "react-native";

import { Text } from "@/components/ui/text";
import { TerminalKeyBar, controlByte } from "@/components/terminal/TerminalKeyBar";
import { TerminalWebView, type TerminalViewHandle } from "@/components/terminal/TerminalWebView";
import { useTerminalSession, type TerminalStatus } from "@/lib/use-terminal-session";

interface TerminalSurfaceProps {
  /** Host session to attach to. An agent tab is a terminal session too. */
  tabId: string;
  /**
   * Whether this surface currently owns the session's viewport. False keeps
   * the renderer mounted — and its screen intact — while releasing the lease,
   * which is what lets an agent view sit behind its chat tab without resizing
   * the desktop's grid.
   */
  attached: boolean;
  /** The shell reported a new window title. */
  onTitle?: (title: string) => void;
}

/**
 * One attached terminal session: status line, renderer, and the key bar.
 *
 * Shared by the standalone terminal screen and the terminal tab of an agent
 * view, so the raw TUI behaves identically in both — the same emulator, the
 * same sticky-Ctrl handling, the same paste path.
 */
export function TerminalSurface({ attached, onTitle, tabId }: TerminalSurfaceProps) {
  const renderer = useRef<TerminalViewHandle>(null);
  const [controlArmed, setControlArmed] = useState(false);

  const session = useTerminalSession(
    tabId,
    {
      onOutput: (dataBase64) => renderer.current?.send({ type: "write", dataBase64 }),
      onReset: () => renderer.current?.send({ type: "reset" }),
      onTitle,
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
    const paste = async (): Promise<void> => {
      const text = await readClipboard();
      if (text === null) {
        Alert.alert(
          "Paste unavailable",
          "This build of Pragma Go cannot read the clipboard. Rebuild the dev client to enable it.",
        );
        return;
      }
      // Through the renderer, not as raw input: `paste` honours the program's
      // bracketed-paste mode, which is what stops a multi-line paste from
      // running each line as its own command.
      if (text) renderer.current?.send({ type: "paste", text });
    };
    void paste();
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1"
    >
      <StatusLine error={session.error} exitCode={session.exitCode} status={session.status} />
      <View className="flex-1">
        <TerminalWebView
          onInput={handleInput}
          onLink={(url) => void Linking.openURL(url)}
          onReady={() => {
            if (attached) renderer.current?.send({ type: "focus" });
          }}
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

/**
 * Reads the clipboard, or null when this build cannot.
 *
 * Loaded on demand rather than imported: `expo-clipboard` resolves its native
 * module at import time, so a static import would throw while the router is
 * still registering routes — taking the whole app down at launch on any client
 * built before the dependency was added. Paste is worth a lazy import; the app
 * starting is not worth risking for it.
 */
async function readClipboard(): Promise<string | null> {
  try {
    const clipboard = await import("expo-clipboard");
    return await clipboard.getStringAsync();
  } catch {
    return null;
  }
}
