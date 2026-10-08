import {
  buildCodeViewerHtml,
  codeViewerBackground,
  parseCodeViewerMessage,
} from "@pragma-sh/code-viewer";
import { useEffect, useMemo, useState } from "react";
import { View, useColorScheme } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { CodeWebViewProps } from "./code-view-props";

/**
 * A read-only file or diff, rendered by CodeMirror in a web view.
 *
 * The editor runs inside the document for the same reason the terminal does:
 * the desktop's CodeMirror setup — grammars, palette, the unified diff — is the
 * part not worth reimplementing, and sharing it keeps a file looking the same
 * on both. The content is baked into the document when it is built, so there
 * is nothing to stream in and nothing that could write back.
 */
export function CodeWebView({ content, wrap, onReady }: CodeWebViewProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const html = useMemo(
    () => buildCodeViewerHtml({ content, mode: scheme, wrap }),
    [content, scheme, wrap],
  );
  const background = codeViewerBackground(scheme);
  // Transparent until the document reports it has painted, so the web view's
  // own white first frame never shows over a dark container.
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(false), [html]);

  const handleMessage = (event: WebViewMessageEvent): void => {
    const message = parseCodeViewerMessage(event.nativeEvent.data);
    if (message?.type !== "ready") return;
    setPainted(true);
    onReady?.();
  };

  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <WebView
        allowFileAccess={false}
        onMessage={handleMessage}
        // The document is generated locally and never navigates.
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        originWhitelist={["about:blank"]}
        scalesPageToFit={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={{ backgroundColor: background, flex: 1, opacity: painted ? 1 : 0 }}
      />
    </View>
  );
}
