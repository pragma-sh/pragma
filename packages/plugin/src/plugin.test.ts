import { describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION } from "./generated/version";
import { defineWebView, openWebView } from "./contributions";
import { definePlugin, type PluginDefinitionInput } from "./plugin";
import { defineUsageLimitProvider } from "./usage-limits";

describe("definePlugin", () => {
  it("stamps the compiled-against @pragma/plugin version", () => {
    const plugin = definePlugin({ name: "Test Plugin" });
    expect(plugin.__apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("preserves the rest of the plugin definition unchanged", () => {
    const plugin = definePlugin({
      name: "Test Plugin",
      description: "A plugin",
      commands: [],
    });
    expect(plugin.name).toBe("Test Plugin");
    expect(plugin.description).toBe("A plugin");
    expect(plugin.commands).toEqual([]);
  });

  it("never lets a caller override the stamped version", () => {
    const spoofed = {
      name: "Spoofed",
      __apiVersion: "999.0.0",
    } as PluginDefinitionInput;
    expect(definePlugin(spoofed).__apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("preserves web view contributions", () => {
    const webView = defineWebView({ id: "report", component: () => null });
    const plugin = definePlugin({ name: "Test Plugin", ui: { webViews: [webView] } });

    expect(plugin.ui?.webViews).toEqual([webView]);
  });

  it("preserves usage-limit providers", () => {
    const provider = defineUsageLimitProvider({
      id: "cursor",
      title: "Cursor",
      dashboardUrl: "https://cursor.com/dashboard/spending",
      primaryLimitId: "plan",
      load: async () => ({ status: "ready", observedAt: 1, limits: [] }),
    });
    const plugin = definePlugin({ name: "Test Plugin", usageLimits: [provider] });

    expect(plugin.usageLimits).toEqual([provider]);
  });
});

describe("defineWebView", () => {
  it("opens itself through the host bridge action", async () => {
    const calls: unknown[] = [];
    globalThis.__PRAGMA__ = {
      actions: {
        openWebView: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    } as never;
    const webView = defineWebView<{ id: string }>({ id: "report", component: () => null });

    await webView.open({ payload: { id: "1" }, dedupeKey: "1" });

    expect(calls).toEqual([[webView, { payload: { id: "1" }, dedupeKey: "1" }]]);
    globalThis.__PRAGMA__ = undefined;
  });

  it("opens string ids through the host bridge action", async () => {
    const calls: unknown[] = [];
    globalThis.__PRAGMA__ = {
      actions: {
        openWebView: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    } as never;

    await openWebView("report", { title: "Report" });

    expect(calls).toEqual([["report", { title: "Report" }]]);
    globalThis.__PRAGMA__ = undefined;
  });
});
