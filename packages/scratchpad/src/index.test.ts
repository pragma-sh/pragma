/// <reference types="node" />

import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { promptAgent, type ScratchpadBridge } from "./index";

afterEach(() => {
  globalThis.pragmaScratchpad = undefined;
});

function installBridge(promptResults: Array<"sent" | "missing-agent">): ScratchpadBridge {
  const bridge: ScratchpadBridge = {
    promptAgent: vi.fn(async () => promptResults.shift() ?? "sent"),
    requestAgentAttachment: vi.fn(async () => true),
    subscribeAgentProgress: () => () => undefined,
  };
  globalThis.pragmaScratchpad = bridge;
  return bridge;
}

describe("promptAgent", () => {
  it("sends directly when an agent is attached", async () => {
    const bridge = installBridge(["sent"]);
    await expect(promptAgent("  address comments  ")).resolves.toBe(true);
    expect(bridge.promptAgent).toHaveBeenCalledWith("address comments");
  });

  it("opens default attachment picker and retries", async () => {
    const bridge = installBridge(["missing-agent", "sent"]);
    await expect(promptAgent("continue")).resolves.toBe(true);
    expect(bridge.requestAgentAttachment).toHaveBeenCalledOnce();
    expect(bridge.promptAgent).toHaveBeenCalledTimes(2);
  });

  it("allows custom missing-agent behavior", async () => {
    const bridge = installBridge(["missing-agent"]);
    const onMissingAgent = vi.fn(async () => false);
    await expect(promptAgent("continue", { onMissingAgent })).resolves.toBe(false);
    expect(onMissingAgent).toHaveBeenCalledOnce();
    expect(bridge.requestAgentAttachment).not.toHaveBeenCalled();
  });
});

describe("browser build", () => {
  it.each(["ui.js", "ui.cjs", "primitives.js", "primitives.cjs"])(
    "uses production-safe JSX in dist/%s",
    async (file) => {
      const output = await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8");
      expect(output).not.toContain("jsxDEV");
      expect(output).toContain("jsx-runtime");
    },
  );
});
