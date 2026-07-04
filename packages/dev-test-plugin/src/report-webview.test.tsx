import { describe, expect, it } from "vitest";

import { createBridge, setBridge } from "./test/bridge";
import { openReportWebView, reportWebView } from "./report-webview";

describe("report web view", () => {
  it("opens through the plugin bridge action", async () => {
    const calls: unknown[] = [];
    const handle = createBridge();
    handle.bridge.actions.openWebView = async (...args: unknown[]) => {
      calls.push(args);
    };
    setBridge(handle);

    await openReportWebView();

    const first = calls[0] as unknown[] | undefined;
    expect(first?.[0]).toBe(reportWebView);
    expect(first?.[1]).toMatchObject({ title: "Plugin Report", dedupeKey: "dev-report" });
  });
});
