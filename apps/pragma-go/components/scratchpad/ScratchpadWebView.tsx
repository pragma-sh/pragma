import {
  buildScratchpadViewerHtml,
  scratchpadThemeCss,
  type ScratchpadBlock,
  type ScratchpadComment,
  type ScratchpadViewerCommand,
  type ScratchpadViewerMessage,
} from "@pragma/scratchpad-viewer";
import { useEffect, useMemo, useRef, useState } from "react";
import { View, useColorScheme } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { ScratchpadLoading } from "@/components/scratchpad/ScratchpadLoading";
import { useHostThemeOverrides } from "@/lib/theme-context";

export interface ScratchpadWebViewProps {
  /** The scratchpad's MDX source, frontmatter included. */
  source: string;
  /** Comments to highlight; pushed into the document without reloading it. */
  comments: readonly ScratchpadComment[];
  /** Whether tap/long-press picks a block to comment on. */
  commentMode: boolean;
  /** A tap, or the release of a long press, chose a block. */
  onSelect: (block: ScratchpadBlock) => void;
  /** A long press is hovering a block — where the comment would land. */
  onPreview: (block: ScratchpadBlock | null) => void;
  /** A rendered component asked to prompt the attached agent. */
  onPromptAgent: (text: string) => Promise<"sent" | "missing-agent" | "cancelled">;
  /** A rendered component asked the host to attach an agent tab. */
  onRequestAttachment: () => Promise<boolean>;
  /** The document failed to render, or a component threw. */
  onError: (message: string) => void;
}

/**
 * Renders one scratchpad read-only in a web view.
 *
 * The document is built by `@pragma/scratchpad-viewer` and handed over as a
 * string: it evaluates the MDX with the real `@pragma/scratchpad` components, so
 * an interactive block a desktop user would see is the same block here. The
 * page is rebuilt only when its source or palette changes — comments and
 * comment mode are pushed in as commands, because rebuilding the HTML remounts
 * the document and would throw away the reader's scroll position.
 */
export function ScratchpadWebView(props: ScratchpadWebViewProps) {
  const { source, comments, commentMode } = props;
  const webView = useRef<WebView>(null);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const overrides = useHostThemeOverrides();
  const themeCss = useMemo(() => scratchpadThemeCss(overrides), [overrides]);
  const html = useMemo(
    () => buildScratchpadViewerHtml({ source, mode: scheme, themeCss }),
    [scheme, source, themeCss],
  );
  // Cover the web view until MDX finishes evaluating; a source or palette
  // rebuild starts the wait over again.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [html]);

  const send = (command: ScratchpadViewerCommand): void => {
    // Double-encoded on purpose: the inner JSON is the command, the outer one
    // makes it a valid string literal inside the injected script.
    const payload = JSON.stringify(JSON.stringify(command));
    webView.current?.injectJavaScript(`window.pragmaScratchpadViewer?.receive(${payload});true;`);
  };

  useEffect(() => {
    send({ type: "comments", comments: [...comments] });
    // `send` is a stable closure over the ref, which never changes identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [comments]);

  useEffect(() => {
    send({ type: "commentMode", active: commentMode });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [commentMode]);

  const respond = (requestId: string, value: unknown): void =>
    send({ type: "response", requestId, value });

  /** Routes one page message to the prop that owns it. */
  const handlers: {
    [K in ScratchpadViewerMessage["type"]]: (
      message: Extract<ScratchpadViewerMessage, { type: K }>,
    ) => void;
  } = {
    select: (message) => props.onSelect(message.block),
    preview: (message) => props.onPreview(message.block),
    error: (message) => props.onError(message.message),
    promptAgent: (message) => {
      void props.onPromptAgent(message.text).then((result) => respond(message.requestId, result));
    },
    requestAgentAttachment: (message) => {
      void props.onRequestAttachment().then((ok) => respond(message.requestId, ok));
    },
    // Live agent progress is the chat screen's job on mobile; a component that
    // asks for it gets an empty roster rather than a hanging promise.
    subscribeAgentProgress: (message) =>
      send({ type: "progress", requestId: message.requestId, entries: [] }),
    unsubscribeAgentProgress: () => undefined,
    ready: () => setReady(true),
    height: () => undefined,
  };

  const handleMessage = (event: WebViewMessageEvent): void => {
    let message: ScratchpadViewerMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as ScratchpadViewerMessage;
    } catch {
      return;
    }
    (handlers[message.type] as (value: ScratchpadViewerMessage) => void)(message);
  };

  return (
    <View className="flex-1 bg-background">
      <WebView
        allowFileAccess={false}
        androidLayerType="hardware"
        className="flex-1 bg-background"
        // The document is generated locally and never navigates; anything that
        // tries to leave it is a link in the scratchpad, which belongs in a
        // browser, not in this read-only view.
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        originWhitelist={["about:blank"]}
        ref={webView}
        source={{ html }}
        // A phone reader scrolls the document itself; letting the page zoom fights
        // the long-press picker.
        scalesPageToFit={false}
        setSupportMultipleWindows={false}
      />
      {!ready ? <ScratchpadLoading label="Loading scratchpad…" overlay /> : null}
    </View>
  );
}
