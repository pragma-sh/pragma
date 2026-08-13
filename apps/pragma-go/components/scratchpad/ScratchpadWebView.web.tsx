import {
  buildScratchpadViewerHtml,
  scratchpadThemeCss,
  type ScratchpadViewerCommand,
  type ScratchpadViewerMessage,
} from "@pragma/scratchpad-viewer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, useColorScheme } from "react-native";

import { ScratchpadLoading } from "@/components/scratchpad/ScratchpadLoading";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useHostThemeOverrides } from "@/lib/theme-context";

import type { ScratchpadWebViewProps } from "./ScratchpadWebView";

type PromptAgentMessage = Extract<ScratchpadViewerMessage, { type: "promptAgent" }>;

// Web counterpart of `ScratchpadWebView.tsx`. Same generated document, same
// message protocol — a sandboxed <iframe> stands in for the native web view.
//
// `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an
// opaque origin, so scratchpad content (which is agent-authored MDX, evaluated
// at run time) cannot read this page's storage and therefore cannot reach the
// gateway token. That isolation is what makes running the viewer in a browser
// safe; it is not a detail to relax for convenience.

/** Renders one scratchpad read-only in a sandboxed frame. */
export function ScratchpadWebView(props: ScratchpadWebViewProps) {
  const { source, comments, commentMode } = props;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const overrides = useHostThemeOverrides();
  const themeCss = useMemo(() => scratchpadThemeCss(overrides), [overrides]);
  const html = useMemo(
    () => buildScratchpadViewerHtml({ source, mode: scheme, themeCss }),
    [scheme, source, themeCss],
  );
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [html]);

  const send = useCallback((command: ScratchpadViewerCommand): void => {
    frame.current?.contentWindow?.postMessage(JSON.stringify(command), "*");
  }, []);

  useEffect(() => {
    if (ready) send({ type: "comments", comments: [...comments] });
  }, [comments, ready, send]);

  useEffect(() => {
    if (ready) send({ type: "commentMode", active: commentMode });
  }, [commentMode, ready, send]);

  const promptConfirmation = usePromptAgentConfirmation(props.onPromptAgent, send);

  useViewerMessages(frame, props, promptConfirmation.requestPromptAgent, send, setReady);

  return (
    <View className="flex-1 bg-background">
      <iframe
        // srcDoc keeps the document local: the frame never fetches anything, so
        // there is no URL for a scratchpad to navigate the host away to.
        ref={frame}
        sandbox="allow-scripts"
        srcDoc={html}
        style={{ border: "none", flex: 1, height: "100%", width: "100%" }}
        title="Scratchpad"
      />
      {!ready ? <ScratchpadLoading label="Loading scratchpad…" overlay /> : null}
      <PromptAgentSheet {...promptConfirmation} />
    </View>
  );
}

/** Holds one untrusted prompt until a reader explicitly sends or cancels it. */
function usePromptAgentConfirmation(
  onPromptAgent: ScratchpadWebViewProps["onPromptAgent"],
  send: (command: ScratchpadViewerCommand) => void,
) {
  const [request, setRequest] = useState<PromptAgentMessage | null>(null);
  const [sending, setSending] = useState(false);
  const requestRef = useRef<PromptAgentMessage | null>(null);
  const sendingRef = useRef(false);
  const promptAgentRef = useRef(onPromptAgent);
  promptAgentRef.current = onPromptAgent;

  const clear = useCallback((): void => {
    requestRef.current = null;
    sendingRef.current = false;
    setRequest(null);
    setSending(false);
  }, []);

  const requestPromptAgent = useCallback((message: PromptAgentMessage): boolean => {
    // One modal is enough: an untrusted document must not stack confirmations.
    if (requestRef.current) return false;
    requestRef.current = message;
    setRequest(message);
    return true;
  }, []);

  const onCancel = useCallback((): void => {
    const pending = requestRef.current;
    if (!pending || sendingRef.current) return;
    send({ type: "response", requestId: pending.requestId, value: "cancelled" });
    clear();
  }, [clear, send]);

  const onSend = useCallback((): void => {
    const pending = requestRef.current;
    if (!pending || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    void promptResponse(pending, promptAgentRef.current).then((response) => {
      send(response);
      clear();
      return undefined;
    });
  }, [clear, send]);

  return { onCancel, onSend, request, requestPromptAgent, sending };
}

async function promptResponse(
  request: PromptAgentMessage,
  onPromptAgent: ScratchpadWebViewProps["onPromptAgent"],
): Promise<Extract<ScratchpadViewerCommand, { type: "response" }>> {
  try {
    return {
      type: "response",
      requestId: request.requestId,
      value: await onPromptAgent(request.text),
    };
  } catch (cause) {
    return {
      type: "response",
      requestId: request.requestId,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Requires reader consent before agent-authored MDX can message an attached agent. */
function PromptAgentSheet({
  onCancel,
  onSend,
  request,
  sending,
}: {
  onCancel: () => void;
  onSend: () => void;
  request: PromptAgentMessage | null;
  sending: boolean;
}) {
  return (
    <BottomSheet onOpenChange={(open) => !open && onCancel()} open={request !== null}>
      <Text className="text-lg font-semibold text-foreground">Send message to agent?</Text>
      <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={6}>
        {request?.text}
      </Text>
      <View className="mt-4 flex-row gap-3">
        <Button className="flex-1" disabled={sending} onPress={onCancel} variant="secondary">
          <Text>Cancel</Text>
        </Button>
        <Button className="flex-1" disabled={sending} onPress={onSend}>
          <Text>{sending ? "Sending…" : "Send"}</Text>
        </Button>
      </View>
    </BottomSheet>
  );
}

/**
 * Decodes one `postMessage` payload, or null when it is not one of ours. Other
 * libraries post to `window` too, so anything unparseable is ignored rather
 * than treated as a viewer error.
 */
function parseViewerMessage(data: unknown): ScratchpadViewerMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as ScratchpadViewerMessage;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the frame's messages and routes each one to the prop that owns
 * it. Messages from anything other than this frame are ignored — the page can
 * host other frames, and the sandboxed origin gives nothing else to check.
 */
function useViewerMessages(
  frame: React.RefObject<HTMLIFrameElement | null>,
  props: ScratchpadWebViewProps,
  requestPromptAgent: (message: PromptAgentMessage) => boolean,
  send: (command: ScratchpadViewerCommand) => void,
  setReady: (ready: boolean) => void,
): void {
  // Handlers close over props that change every render; a ref keeps the
  // listener subscribed once instead of re-binding on each keystroke.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const respond = (requestId: string, value: unknown): void =>
      send({ type: "response", requestId, value });

    const handlers: {
      [K in ScratchpadViewerMessage["type"]]: (
        message: Extract<ScratchpadViewerMessage, { type: K }>,
      ) => void;
    } = {
      select: (message) => latest.current.onSelect(message.block),
      preview: (message) => latest.current.onPreview(message.block),
      error: (message) => latest.current.onError(message.message),
      promptAgent: (message) => {
        if (!requestPromptAgent(message)) respond(message.requestId, "cancelled");
      },
      requestAgentAttachment: (message) => {
        void latest.current.onRequestAttachment().then((ok) => respond(message.requestId, ok));
      },
      // Live agent progress belongs to the chat screen here too, so a component
      // that asks for it gets an empty roster rather than a hanging promise.
      subscribeAgentProgress: (message) =>
        send({ type: "progress", requestId: message.requestId, entries: [] }),
      unsubscribeAgentProgress: () => undefined,
      ready: () => setReady(true),
      height: () => undefined,
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseViewerMessage(event.data);
      if (!message) return;
      (handlers[message.type] as (value: ScratchpadViewerMessage) => void)(message);
    };

    globalThis.addEventListener("message", onMessage);
    return () => globalThis.removeEventListener("message", onMessage);
  }, [frame, requestPromptAgent, send, setReady]);
}
