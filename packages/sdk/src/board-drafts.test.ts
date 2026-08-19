import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

describe("createBoardDraft", () => {
  it("POSTs requested launch selection to boardDraftCreate", async () => {
    let url: string | undefined;
    let body: BodyInit | null | undefined;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        url = String(target);
        body = init?.body;
        return new Response(
          JSON.stringify({
            id: "card-1",
            projectId: "project-1",
            branchName: "feature/board",
            prompt: "Build it",
            agentId: "opencode",
            modelId: "gpt-5",
            reasoningId: "high",
            status: "draft",
            schedulingMode: "manual",
            createdAt: "2026-08-16T00:00:00Z",
            updatedAt: "2026-08-16T00:00:00Z",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const card = await client.createBoardDraft({
      prompt: "Build it",
      worktreeId: "worktree-1",
      agentId: "opencode",
      modelId: "gpt-5",
      reasoningId: "high",
    });

    expect(url).toBe("http://127.0.0.1:1/v1/control/boardDraftCreate");
    expect(JSON.parse(String(body))).toEqual({
      prompt: "Build it",
      worktreeId: "worktree-1",
      agentId: "opencode",
      modelId: "gpt-5",
      reasoningId: "high",
    });
    expect(card.id).toBe("card-1");
  });
});
