import { afterEach, describe, expect, it } from "vitest";

import type { PluginDefinition, WebViewDefinition } from "@pragma/plugin";

import type { PluginRecord } from "./registry";
import { openRegisteredWebView, setPluginWebViewOpener, setPluginWebViews } from "./webviews";

function webView(id: string): WebViewDefinition {
  return { id, component: () => null, open: async () => undefined };
}

function record(pluginId: string, views: WebViewDefinition[]): PluginRecord {
  return {
    pluginId,
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    definition: {
      name: pluginId,
      ui: { webViews: views },
      __apiVersion: "1.0.0",
    } as PluginDefinition,
  };
}

afterEach(() => {
  setPluginWebViews([]);
  setPluginWebViewOpener(null);
});

describe("plugin web views", () => {
  it("opens a registered handle", async () => {
    const report = webView("report");
    const calls: unknown[] = [];
    setPluginWebViews([record("plugin-a", [report])]);
    setPluginWebViewOpener(async (request) => {
      calls.push(request);
    });

    await openRegisteredWebView(report, { payload: { ok: true }, dedupeKey: "latest" });

    expect(calls).toEqual([
      {
        pluginId: "plugin-a",
        pluginViewId: "report",
        title: "report",
        payloadJson: '{"ok":true}',
        dedupeKey: "latest",
      },
    ]);
  });

  it("opens a unique string id", async () => {
    const calls: unknown[] = [];
    setPluginWebViews([record("plugin-a", [webView("report")])]);
    setPluginWebViewOpener(async (request) => {
      calls.push(request.pluginViewId);
    });

    await openRegisteredWebView("report");

    expect(calls).toEqual(["report"]);
  });

  it("rejects ambiguous string ids", async () => {
    setPluginWebViews([record("a", [webView("report")]), record("b", [webView("report")])]);
    setPluginWebViewOpener(async () => undefined);

    await expect(openRegisteredWebView("report")).rejects.toThrow(/ambiguous/);
  });
});
