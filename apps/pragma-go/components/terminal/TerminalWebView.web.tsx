import {
  buildTerminalViewerHtml,
  terminalBackgroundColor,
  terminalThemeCss,
  type TerminalViewerCommand,
} from "@pragma/terminal-viewer";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { View, useColorScheme } from "react-native";

import { createTerminalCommandQueue } from "@/lib/terminal-command-queue";
import { useHostThemeOverrides } from "@/lib/theme-context";
import { terminalMessageHandler, type TerminalViewProps } from "./terminal-bridge";

import type { TerminalViewHandle } from "./TerminalWebView";

// Web counterpart of `TerminalWebView.tsx`: same generated document, same
// message protocol, with a sandboxed <iframe> standing in for the native web
// view. `sandbox="allow-scripts"` without `allow-same-origin` gives the frame
// an opaque origin, so the terminal document cannot read this page's storage
// and therefore cannot reach the gateway token. Terminal output is arbitrary
// bytes from whatever is running in the shell; that isolation is the point.

/** Renders one terminal session in a sandboxed frame. */
export const TerminalWebView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalWebView(props, ref) {
    const frame = useRef<HTMLIFrameElement | null>(null);
    const scheme = useColorScheme() === "dark" ? "dark" : "light";
    const overrides = useHostThemeOverrides();
    const themeCss = useMemo(() => terminalThemeCss(overrides), [overrides]);
    const parentOrigin = typeof window === "undefined" ? "*" : window.location.origin;
    const html = useMemo(
      () => buildTerminalViewerHtml({ mode: scheme, themeCss, parentOrigin }),
      [parentOrigin, scheme, themeCss],
    );
    // Same hand-off as the native twin: the container is already the color the
    // document will paint, and the frame is revealed only once it has.
    const background = useMemo(
      () => terminalBackgroundColor(scheme, overrides),
      [overrides, scheme],
    );
    const [painted, setPainted] = useState(false);
    useEffect(() => setPainted(false), [html]);

    // A frame that has not loaded drops what is posted to it, and a session's
    // replay usually arrives first, so commands wait for the document's ready
    // signal. Same gate as the native twin, same reason.
    const queue = useMemo(
      () =>
        createTerminalCommandQueue((command: TerminalViewerCommand) => {
          // The frame's origin is opaque, so "*" is the only address that
          // reaches it; the payload is terminal data, not a secret.
          frame.current?.contentWindow?.postMessage(JSON.stringify(command), "*");
        }),
      [],
    );
    // A new palette rebuilds the document; hold again until it reports ready.
    useEffect(() => queue.reset(), [html, queue]);

    useImperativeHandle(ref, () => ({ send: queue.send }), [queue]);

    const latest = useRef(props);
    latest.current = props;

    useEffect(() => {
      const handle = terminalMessageHandler({
        onReady: () => {
          setPainted(true);
          queue.ready();
          latest.current.onReady();
        },
        onInput: (data) => latest.current.onInput(data),
        onResize: (cols, rows) => latest.current.onResize(cols, rows),
        onWritten: (bytes) => latest.current.onWritten?.(bytes),
        onLink: (url) => latest.current.onLink?.(url),
        onScroll: (atBottom) => latest.current.onScroll?.(atBottom),
      });
      const onMessage = (event: MessageEvent): void => {
        // The page can host other frames, and a sandboxed origin gives nothing
        // else to check against.
        if (event.source !== frame.current?.contentWindow) return;
        if (typeof event.data === "string") handle(event.data);
      };
      globalThis.addEventListener("message", onMessage);
      return () => globalThis.removeEventListener("message", onMessage);
    }, [queue]);

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
          title="Terminal"
        />
      </View>
    );
  },
);
