import type { OpenWebViewOptions, WebViewDefinition, WebViewReference } from "@pragma/plugin";

import type { PluginRecord } from "./registry";

/** Request handed from plugin runtime to workspace tab management. */
export interface OpenPluginWebViewRequest {
  pluginId: string;
  pluginViewId: string;
  title: string;
  payloadJson: string | null;
  dedupeKey: string | null;
}

type OpenPluginWebView = (request: OpenPluginWebViewRequest) => Promise<void>;

interface RegisteredWebView {
  pluginId: string;
  webView: WebViewDefinition;
}

let activeWebViews: RegisteredWebView[] = [];
let opener: OpenPluginWebView | null = null;

/** Publishes currently active plugin web view contributions for `openWebView`. */
export function setPluginWebViews(records: readonly PluginRecord[]): void {
  activeWebViews = [];
  for (const record of records) {
    if (record.status !== "loaded" || !record.definition) {
      continue;
    }
    for (const webView of record.definition.ui?.webViews ?? []) {
      activeWebViews.push({ pluginId: record.pluginId, webView });
    }
  }
}

/** Installs the workspace opener used by the global plugin bridge action. */
export function setPluginWebViewOpener(next: OpenPluginWebView | null): void {
  opener = next;
}

/** Opens a registered plugin web view by handle, or by unique id. */
export async function openRegisteredWebView<TPayload = unknown>(
  reference: WebViewReference<TPayload>,
  options: OpenWebViewOptions<TPayload> = {},
): Promise<void> {
  if (!opener) {
    throw new Error("@pragma/plugin: openWebView is unavailable before the workspace is ready");
  }
  const registered = resolveWebView(reference);
  const payloadJson = encodePayload(options.payload);
  await opener({
    pluginId: registered.pluginId,
    pluginViewId: registered.webView.id,
    title: options.title ?? registered.webView.title ?? registered.webView.id,
    payloadJson,
    dedupeKey: options.dedupeKey ?? null,
  });
}

function resolveWebView<TPayload>(reference: WebViewReference<TPayload>): RegisteredWebView {
  if (typeof reference !== "string") {
    const registered = activeWebViews.find((candidate) => candidate.webView === reference);
    if (!registered) {
      throw new Error(
        `@pragma/plugin: web view "${reference.id}" is not registered by an active plugin`,
      );
    }
    return registered;
  }

  const matches = activeWebViews.filter((candidate) => candidate.webView.id === reference);
  if (matches.length === 0) {
    throw new Error(`@pragma/plugin: web view "${reference}" was not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `@pragma/plugin: web view id "${reference}" is ambiguous; pass the defineWebView() handle instead`,
    );
  }
  return matches[0] as RegisteredWebView;
}

function encodePayload(payload: unknown): string | null {
  if (payload === undefined) {
    return null;
  }
  try {
    return JSON.stringify(payload);
  } catch (cause) {
    throw new Error(
      `@pragma/plugin: web view payload must be JSON-serializable (${String(cause)})`,
      { cause },
    );
  }
}
