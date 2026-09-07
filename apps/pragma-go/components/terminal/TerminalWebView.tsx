import {
  buildTerminalViewerHtml,
  terminalCommandScript,
  terminalThemeCss,
  type TerminalViewerCommand,
} from "@pragma/terminal-viewer";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { View, useColorScheme } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { useHostThemeOverrides } from "@/lib/theme-context";
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
    const scheme = useColorScheme() === "dark" ? "dark" : "light";
    const overrides = useHostThemeOverrides();
    const themeCss = useMemo(() => terminalThemeCss(overrides), [overrides]);
    // The document is built once per palette: rebuilding it remounts xterm and
    // throws away the screen the session has been writing to.
    const html = useMemo(
      () => buildTerminalViewerHtml({ mode: scheme, themeCss }),
      [scheme, themeCss],
    );

    useImperativeHandle(ref, () => ({
      send: (command: TerminalViewerCommand) => {
        webView.current?.injectJavaScript(terminalCommandScript(command));
      },
    }));

    const handleMessage = terminalMessageHandler(props);

    return (
      <View className="flex-1 bg-background">
        <WebView
          allowFileAccess={false}
          androidLayerType="hardware"
          className="flex-1 bg-background"
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
        />
      </View>
    );
  },
);
