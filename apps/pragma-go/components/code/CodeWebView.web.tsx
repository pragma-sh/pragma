import {
  buildCodeViewerHtml,
  codeViewerBackground,
  parseCodeViewerMessage,
} from "@pragma-sh/code-viewer";
import { useEffect, useMemo, useRef, useState } from "react";
import { View, useColorScheme } from "react-native";

import type { CodeWebViewProps } from "./code-view-props";

// Web counterpart of `CodeWebView.tsx`: the same generated document in a
// sandboxed <iframe>. `allow-scripts` without `allow-same-origin` gives the
// frame an opaque origin, so file contents — arbitrary text from the host —
// cannot read this page's storage and so cannot reach the gateway token.

/** A read-only file or diff, rendered by CodeMirror in a sandboxed frame. */
export function CodeWebView({ content, wrap, onReady }: CodeWebViewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const parentOrigin = typeof window === "undefined" ? "*" : window.location.origin;
  const html = useMemo(
    () => buildCodeViewerHtml({ content, mode: scheme, wrap, parentOrigin }),
    [content, parentOrigin, scheme, wrap],
  );
  const background = codeViewerBackground(scheme);
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(false), [html]);

  const latestOnReady = useRef(onReady);
  latestOnReady.current = onReady;

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!isReadyFrom(event, frame.current?.contentWindow)) return;
      setPainted(true);
      latestOnReady.current?.();
    };
    globalThis.addEventListener("message", onMessage);
    return () => globalThis.removeEventListener("message", onMessage);
  }, []);

  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <iframe
        ref={frame}
        sandbox="allow-scripts"
        srcDoc={html}
        style={{
          backgroundColor: background,
          border: "none",
          flex: 1,
          height: "100%",
          opacity: painted ? 1 : 0,
          width: "100%",
        }}
        title="Code"
      />
    </View>
  );
}

/** A `ready` report from this frame — the page can host other frames, and only its own count. */
function isReadyFrom(event: MessageEvent, source: Window | null | undefined): boolean {
  if (event.source !== source || typeof event.data !== "string") return false;
  return parseCodeViewerMessage(event.data)?.type === "ready";
}
