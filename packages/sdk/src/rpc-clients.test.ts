import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

describe("rpc namespace clients", () => {
  it("maps filesystem operations", async () => {
    const calls: Array<{ input: string; body: string }> = [];
    const client = clientWithFetch(async (input, init) => {
      calls.push({ input, body: String(init?.body) });
      return Response.json(true);
    });

    await client.fs.pathExists({ root: "/repo", path: "README.md" });

    expect(calls).toEqual([
      {
        input: "http://127.0.0.1:1/v1/rpc/filesystem",
        body: JSON.stringify({ op: "pathExists", root: "/repo", path: "README.md" }),
      },
    ]);
  });

  it("maps git operations", async () => {
    let body = "";
    const client = clientWithFetch(async (_input, init) => {
      body = String(init?.body);
      return Response.json(false);
    });

    await client.git.isDirty({ root: "/repo" });

    expect(JSON.parse(body)).toEqual({ op: "isDirty", root: "/repo" });
  });

  it("maps exec operations", async () => {
    let body = "";
    const client = clientWithFetch(async (_input, init) => {
      body = String(init?.body);
      return Response.json([]);
    });

    await client.exec.run({ cwd: "/repo", commands: ["bun test"] });

    expect(JSON.parse(body)).toEqual({
      cwd: "/repo",
      commands: ["bun test"],
      env: [],
      maxConcurrent: 1,
    });
  });

  it("maps whiteboard operations and decodes rendered PNG bytes", async () => {
    const calls: Array<{ input: string; body: unknown }> = [];
    const scene = {
      type: "excalidraw" as const,
      version: 2,
      elements: [],
      appState: {},
      files: {},
    };
    const whiteboard = {
      id: "board-1",
      worktreeId: "worktree-1",
      title: "Architecture",
      scene,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const client = clientWithFetch(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { action: string };
      calls.push({ input, body });
      if (body.action === "list") {
        return Response.json([whiteboard]);
      }
      if (body.action === "delete") {
        return Response.json(null);
      }
      if (body.action === "view") {
        return Response.json({ data: "AQID" });
      }
      return Response.json(whiteboard);
    });

    await expect(
      client.whiteboards.create({ worktreeId: "worktree-1", title: "Architecture", scene }),
    ).resolves.toEqual(whiteboard);
    await expect(
      client.whiteboards.get({ worktreeId: "worktree-1", id: "board-1" }),
    ).resolves.toEqual(whiteboard);
    await expect(client.whiteboards.list({ worktreeId: "worktree-1" })).resolves.toEqual([
      whiteboard,
    ]);
    await expect(
      client.whiteboards.search({ worktreeId: "worktree-1", query: "rectangle" }),
    ).resolves.toEqual([whiteboard]);
    await expect(
      client.whiteboards.edit({
        worktreeId: "worktree-1",
        id: "board-1",
        title: "Architecture",
        scene,
        expectedVersion: 1,
      }),
    ).resolves.toEqual(whiteboard);
    await expect(
      client.whiteboards.delete({ worktreeId: "worktree-1", id: "board-1" }),
    ).resolves.toBeUndefined();
    await expect(
      client.whiteboards.view({ worktreeId: "worktree-1", id: "board-1" }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(calls).toEqual([
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "create", worktreeId: "worktree-1", title: "Architecture", scene },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "get", worktreeId: "worktree-1", id: "board-1" },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "list", worktreeId: "worktree-1" },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "list", worktreeId: "worktree-1", query: "rectangle" },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: {
          action: "edit",
          worktreeId: "worktree-1",
          id: "board-1",
          title: "Architecture",
          scene,
          expectedVersion: 1,
        },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "delete", worktreeId: "worktree-1", id: "board-1" },
      },
      {
        input: "http://127.0.0.1:1/v1/rpc/whiteboards",
        body: { action: "view", worktreeId: "worktree-1", id: "board-1" },
      },
    ]);
  });
});

function clientWithFetch(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}
