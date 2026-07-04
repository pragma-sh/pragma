import { afterEach, describe, expect, it } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import { syncPluginCss } from "./css";
import type { PluginRecord } from "./registry";

function record(pluginId: string, css?: string): PluginRecord {
  return {
    pluginId,
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    definition: { name: pluginId, css, __apiVersion: "1.0.0" } as PluginDefinition,
  };
}

afterEach(() => {
  document.querySelectorAll("style[data-pragma-plugin-css]").forEach((element) => element.remove());
});

describe("syncPluginCss", () => {
  it("injects updates and removes plugin style tags", () => {
    syncPluginCss([record("a", ".a { color: red; }")]);
    expect(document.querySelectorAll("style[data-pragma-plugin-css]")).toHaveLength(1);
    expect(document.head.textContent).toContain("color: red");

    syncPluginCss([record("a", ".a { color: blue; }"), record("b", ".b { color: green; }")]);
    expect(document.querySelectorAll("style[data-pragma-plugin-css]")).toHaveLength(2);
    expect(document.head.textContent).toContain("color: blue");
    expect(document.head.textContent).toContain("color: green");

    syncPluginCss([]);
    expect(document.querySelectorAll("style[data-pragma-plugin-css]")).toHaveLength(0);
  });
});
