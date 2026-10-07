import {
  buildTerminalViewerHtml,
  terminalBackgroundColor,
  terminalCommandScript,
  terminalThemeCss,
  type TerminalViewerCommand,
} from "@pragma-sh/terminal-viewer";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { createTerminalCommandQueue } from "@/lib/terminal-command-queue";
import { useViewerTheme } from "@/lib/theme-context";
import { terminalMessageHandler, type TerminalViewProps } from "./terminal-bridge";

/** Imperative handle the terminal screen drives the renderer through. */
export interface TerminalViewHandle {
  send: (command: TerminalViewerCommand) => void;
}

/**
 * Renders one terminal session in a web view.
 *
 * xterm runs inside the document rather than in React: the emulator is the part
 * that must not be reimplemented, and it is the same one the desktop uses, so
 * an escape sequence renders identically on both. Output is pushed in as
 * commands and never held in React state — a build's worth of output would
 * re-render the tree once per chunk.
 */
export const TerminalWebView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalWebView(props, ref) {
    const webView = useRef<WebView>(null);
    const { scheme, overrides, themeCss } = useViewerTheme(terminalThemeCss);
    // The document is built once per palette: rebuilding it remounts xterm and
    // throws away the screen the session has been writing to.
    const html = useMemo(
      () => buildTerminalViewerHtml({ mode: scheme, themeCss }),
      [scheme, themeCss],
    );
    // The color the document is about to paint, resolved the same way it
    // resolves it. A web view shows the platform's own white surface until its
    // first paint, so the container underneath has to already be this color —
    // otherwise every push into a terminal flashes white.
    const background = useMemo(
      () => terminalBackgroundColor(scheme, overrides),
      [overrides, scheme],
    );
    // ...and the view itself stays transparent until the document says it has
    // painted, so that surface is never what the user sees. Transparent rather
    // than unmounted: xterm has to be laid out to measure a grid at all.
    const [painted, setPainted] = useState(false);
    useEffect(() => setPainted(false), [html]);

    // `injectJavaScript` before the document loads is discarded, and a session's
    // replay usually beats the load. Commands wait for the renderer's own ready
    // signal instead of being thrown at a page that is not there yet.
    const queue = useMemo(
      () =>
        createTerminalCommandQueue((command: TerminalViewerCommand) => {
          webView.current?.injectJavaScript(terminalCommandScript(command));
        }),
      [],
    );
    // A new palette rebuilds the document, so the gate closes until the
    // reloaded page reports itself ready again.
    useEffect(() => queue.reset(), [html, queue]);

    useImperativeHandle(ref, () => ({ send: queue.send }), [queue]);

    const handleMessage = terminalMessageHandler({
      ...props,
      onReady: () => {
        setPainted(true);
        queue.ready();
        props.onReady();
      },
    });

    return (
      <View className="flex-1" style={{ backgroundColor: background }}>
        <WebView
          allowFileAccess={false}
          androidLayerType="hardware"
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          onMessage={(event: WebViewMessageEvent) => handleMessage(event.nativeEvent.data)}
          // The document is generated locally and never navigates. A link in
          // terminal output is reported as a message and opened by the host, so
          // nothing here should ever start a load.
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
          originWhitelist={["about:blank"]}
          ref={webView}
          scalesPageToFit={false}
          setSupportMultipleWindows={false}
          source={{ html }}
          style={{ backgroundColor: background, flex: 1, opacity: painted ? 1 : 0 }}
        />
      </View>
    );
  },
);
