import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";
import type { AgentSessionLaunchResult } from "./types/agents";

describe("agents.launch", () => {
  it("POSTs the agentSessionLaunch control route and returns the result", async () => {
    let url: string | undefined;
    let method: string | undefined;
    let body: unknown;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        url = String(target);
        method = init?.method ?? "GET";
        body = init?.body;
        return new Response(
          JSON.stringify({ worktreeId: "wt-1", tabId: "tab-1" } satisfies AgentSessionLaunchResult),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await client.agents.launch({
      projectId: "p1",
      worktreeId: "wt-1",
      newWorktree: null,
      agentId: "claude-code",
      prompt: "hi",
    });

    expect(url).toBe("http://127.0.0.1:1/v1/control/agentSessionLaunch");
    expect(method).toBe("POST");
    expect(result).toEqual({ worktreeId: "wt-1", tabId: "tab-1" });
    expect(JSON.parse(String(body))).toEqual({
      projectId: "p1",
      worktreeId: "wt-1",
      newWorktree: null,
      agentId: "claude-code",
      prompt: "hi",
    });
  });

  it("surfaces a 409 conflict when the desktop app is not running", async () => {
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () =>
        new Response(JSON.stringify({ code: "conflict", message: "Pragma is not running" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(
      client.agents.launch({
        projectId: "p1",
        worktreeId: "wt-1",
        newWorktree: null,
        agentId: "claude-code",
      }),
    ).rejects.toThrowError(/not running/);
  });
});

describe("workspace.subscribe", () => {
  it("yields snapshot then delta events narrowed to WorkspaceSnapshot", async () => {
    const lines = [
      `{"type":"snapshot","subscription":"workspace","payload":${JSON.stringify({
        projects: [],
        worktrees: [],
        tabs: [],
      })}}`,
      `{"type":"delta","subscription":"workspace","payload":${JSON.stringify({
        projects: [{ id: "p1", name: "P", path: "/p", orderIndex: 0, createdAt: "x" }],
        worktrees: [],
        tabs: [],
      })}}`,
    ];
    let i = 0;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n`));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
    });

    void i;
    const events = [];
    for await (const event of client.workspace.subscribe()) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("snapshot");
    expect(events[0]?.payload.projects).toEqual([]);
    expect(events[1]?.type).toBe("delta");
    expect(events[1]?.payload.projects[0]?.id).toBe("p1");
  });
});
