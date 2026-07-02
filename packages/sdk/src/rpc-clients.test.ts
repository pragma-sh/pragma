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
});

function clientWithFetch(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}
