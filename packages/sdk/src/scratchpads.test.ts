import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

describe("scratchpads namespace", () => {
  it("lists a worktree's scratchpads with their source and attached agent", async () => {
    let requested = "";
    const client = clientWithFetch(async (input) => {
      requested = input;
      return Response.json([
        {
          id: "abc",
          title: "Plan",
          filePath: ".pragma/scratchpads/plan.mdx",
          contents: "---\n---\n# Plan\n",
          agentTabId: "tab-1",
          agentId: "claude",
          createdAt: 1,
        },
      ]);
    });

    const scratchpads = await client.scratchpads.getScratchpads({ root: "/Users/dev/my repo" });

    expect(requested).toBe("http://127.0.0.1:1/v1/scratchpads?root=%2FUsers%2Fdev%2Fmy%20repo");
    expect(scratchpads[0]?.agentId).toBe("claude");
    expect(scratchpads[0]?.contents).toContain("# Plan");
  });
});

function clientWithFetch(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}
