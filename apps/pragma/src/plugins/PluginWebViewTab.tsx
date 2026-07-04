import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Tab } from "@pragma/constants";

import { RenderPluginContribution } from "./rendering";
import { useActivePlugins, type PluginRecord } from "./registry";

const FRAME_ROOT_ID = "pragma-plugin-webview-root";
const HOST_STYLE_ID = "pragma-plugin-webview-host-css";
const THEME_STYLE_ID = "pragma-plugin-webview-theme";
const PLUGIN_STYLE_ID = "pragma-plugin-webview-css";

/** Renders a plugin web view tab inside an isolated iframe document. */
export function PluginWebViewTab({ tab }: { tab: Tab }): ReactNode {
  const records = useActivePlugins(tab.projectId);
  const resolved = resolveTabWebView(records, tab);
  const payload = decodePayload(tab.pluginPayload);

  if (!resolved) {
    return <PluginWebViewPlaceholder message="Plugin web view is unavailable." />;
  }
  if (!payload.ok) {
    return <PluginWebViewPlaceholder message={payload.error} />;
  }

  return (
    <PluginWebViewFrame
      pluginCss={resolved.record.definition?.css ?? ""}
      title={tab.title ?? "Plugin"}
    >
      <RenderPluginContribution
        component={resolved.webView.component}
        config={resolved.record.config}
        pluginId={resolved.record.pluginId}
        resetKey={`${tab.id}:${resolved.record.pluginId}:${resolved.webView.id}`}
        webViewPayload={payload.value}
      />
    </PluginWebViewFrame>
  );
}

function PluginWebViewFrame(props: {
  title: string;
  pluginCss: string;
  children: ReactNode;
}): ReactNode {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const hostCss = useHostCssSnapshot();
  const themeCss = useThemeCssSnapshot();

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) {
      return;
    }
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8" /></head><body><div id="${FRAME_ROOT_ID}"></div></body></html>`,
    );
    doc.close();
    setMountNode(doc.getElementById(FRAME_ROOT_ID));
  }, []);

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) {
      return;
    }
    syncStyle(doc, HOST_STYLE_ID, hostCss);
    syncStyle(doc, THEME_STYLE_ID, themeCss);
    syncStyle(doc, PLUGIN_STYLE_ID, props.pluginCss);
  }, [hostCss, props.pluginCss, themeCss]);

  return (
    <>
      <iframe
        className="block h-full w-full border-0 bg-background"
        ref={iframeRef}
        sandbox="allow-same-origin"
        title={props.title}
      />
      {mountNode ? createPortal(props.children, mountNode) : null}
    </>
  );
}

function useHostCssSnapshot(): string {
  const [css] = useState(collectHostCss);
  return css;
}

function useThemeCssSnapshot(): string {
  const [css, setCss] = useState(buildThemeCss);

  useEffect(() => {
    const update = () => setCss(buildThemeCss());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return css;
}

function buildThemeCss(): string {
  const computed = getComputedStyle(document.documentElement);
  const variables: string[] = [];
  for (let i = 0; i < computed.length; i += 1) {
    const name = computed.item(i);
    if (name.startsWith("--")) {
      variables.push(`${name}: ${computed.getPropertyValue(name).trim()};`);
    }
  }
  return `
    :root {
      color-scheme: ${document.documentElement.classList.contains("dark") ? "dark" : "light"};
      ${variables.join("\n")}
    }
    html, body, #${FRAME_ROOT_ID} { min-height: 100%; height: 100%; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--foreground);
      font-family: var(--font-sans);
    }
    *, ::before, ::after { box-sizing: border-box; }
  `;
}

function collectHostCss(): string {
  const chunks: string[] = [];
  for (const sheet of document.styleSheets) {
    const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null;
    if (owner?.hasAttribute("data-pragma-plugin-css")) {
      continue;
    }
    try {
      chunks.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n"));
    } catch {
      // Ignore cross-origin or otherwise unreadable sheets.
    }
  }
  return chunks.join("\n");
}

function syncStyle(doc: Document, id: string, css: string): void {
  let style = doc.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = id;
    doc.head.append(style);
  }
  if (style.textContent !== css) {
    style.textContent = css;
  }
}

function resolveTabWebView(records: readonly PluginRecord[], tab: Tab) {
  if (!tab.pluginId || !tab.pluginViewId) {
    return null;
  }
  const record = records.find(
    (candidate) => candidate.status === "loaded" && candidate.pluginId === tab.pluginId,
  );
  const webView = record?.definition?.ui?.webViews?.find(
    (candidate) => candidate.id === tab.pluginViewId,
  );
  return record && webView ? { record, webView } : null;
}

function decodePayload(
  raw: string | null,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (cause) {
    return { ok: false, error: `Plugin web view payload is invalid JSON: ${String(cause)}` };
  }
}

function PluginWebViewPlaceholder({ message }: { message: string }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}
