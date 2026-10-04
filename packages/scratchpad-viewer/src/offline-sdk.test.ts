import * as Scratchpad from "@pragma-sh/scratchpad";
import { describe, expect, it, vi } from "vitest";

import { offlineScratchpadScope } from "./offline-sdk";

describe("standalone SDK stubs", () => {
  it("makes client RPCs and nested calls no-ops without using the supplied transport", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not contact the gateway");
    });
    const sdk = offlineScratchpadScope(Scratchpad);
    const client = new sdk.PragmaClient({
      baseUrl: "https://gateway.example",
      token: "secret",
      fetch,
    });
    await expect(client.rpc("exec", {})).resolves.toBeUndefined();
    await expect(
      client.createBoardDraft({ prompt: "hello", worktreeId: "wt", agentId: "agent" }),
    ).resolves.toBeUndefined();
    await expect(
      client.scratchpads.sendAttached({
        root: "/root",
        filePath: "plan.mdx",
        worktreeId: "wt",
        text: "feedback",
      }),
    ).resolves.toEqual({ delivered: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty streams and disconnected agent connections", async () => {
    const sdk = offlineScratchpadScope(Scratchpad);
    const client = new sdk.PragmaClient();
    const connection = await client.agents.connect({
      agent: "agent",
      tabId: "tab",
      worktreeId: "wt",
    });
    await expect(connection.send("feedback")).resolves.toBeUndefined();
    const entries = [];
    for await (const entry of connection) entries.push(entry);
    expect(entries).toEqual([]);
  });

  it("stubs reporting and environment access but retains pure local utilities", async () => {
    const sdk = offlineScratchpadScope(Scratchpad);
    expect(
      sdk.hasPragmaEnvironment({
        PRAGMA_GATEWAY_URL: "https://gateway.example",
        PRAGMA_GATEWAY_TOKEN: "secret",
        PRAGMA_TAB_ID: "tab",
        PRAGMA_WORKTREE_ID: "wt",
      }),
    ).toBe(false);
    expect(sdk.readEnv("PRAGMA_GATEWAY_TOKEN", { PRAGMA_GATEWAY_TOKEN: "secret" })).toBeUndefined();
    await expect(sdk.reportStarted({ agent: "agent" })).resolves.toBeUndefined();
    await expect(
      sdk.awaitAgentAnswer({ agent: "agent", requestId: "request" }),
    ).resolves.toBeNull();
    expect(sdk.bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(sdk.promptAgent).toBe(Scratchpad.promptAgent);
  });
});
