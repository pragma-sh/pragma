import { parseScratchpadComments, parseScratchpadDocument } from "@pragma/scratchpad-contract";
import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

/** A managed scratchpad file, attached to `tab-1` unless overridden. */
function source(
  agent: { tabId: string; agentId: string } | null = {
    tabId: "tab-1",
    agentId: "pragma.claude-code",
  },
): string {
  const metadata = {
    version: 1,
    id: "abc",
    title: "Plan",
    agentTabId: agent?.tabId ?? null,
    agentId: agent?.agentId ?? null,
    createdAt: 1,
  };
  return `---\npragmaScratchpad: ${JSON.stringify(metadata)}\n---\n# Plan\n`;
}

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

  it("reads an empty thread when a scratchpad has no comment file", async () => {
    const { client } = fsClient({});

    await expect(
      client.scratchpads.getComments({ root: "/repo", filePath: "plan.mdx" }),
    ).resolves.toEqual([]);
  });

  it("appends a comment to the sibling comment file", async () => {
    const { client, files } = fsClient({
      "plan.mdx.comments.json": JSON.stringify([
        {
          id: "existing",
          from: 0,
          to: 0,
          quote: "Old",
          text: "first",
          createdAt: 1,
          resolvedAt: null,
        },
      ]),
    });

    const comment = await client.scratchpads.comment({
      root: "/repo",
      filePath: "plan.mdx",
      block: { index: 2, quote: "Step two" },
      text: "  make this concrete  ",
      id: "new-1",
      createdAt: 42,
    });

    expect(comment).toEqual({
      id: "new-1",
      from: 0,
      to: 0,
      quote: "Step two",
      text: "make this concrete",
      createdAt: 42,
      resolvedAt: null,
      blockIndex: 2,
    });
    const written = parseScratchpadComments(files["plan.mdx.comments.json"] ?? "");
    expect(written.map((entry) => entry.id)).toEqual(["existing", "new-1"]);
  });

  it("records the attached agent in managed frontmatter", async () => {
    const { client, files } = fsClient({ "plan.mdx": source(null) });

    await client.scratchpads.attachAgent({
      root: "/repo",
      filePath: "plan.mdx",
      tabId: "tab-9",
      agentId: "pragma.claude-code",
    });

    const { metadata } = parseScratchpadDocument(files["plan.mdx"] ?? "");
    expect(metadata.agentTabId).toBe("tab-9");
    expect(metadata.agentId).toBe("pragma.claude-code");
  });

  /**
   * The agent event stream is keyed by the plugin's runtime id, so a prompt
   * addressed with the catalog id from frontmatter is invisible to the agent.
   */
  it("sends to the attached agent under its runtime id", async () => {
    const posted: unknown[] = [];
    const { client } = fsClient({ "plan.mdx": source() }, (input, init) => {
      if (!input.endsWith("/v1/agents/inputs")) return null;
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });

    const result = await client.scratchpads.sendAttached({
      root: "/repo",
      filePath: "plan.mdx",
      worktreeId: "wt-1",
      text: "address the comments",
    });

    expect(result).toEqual({ delivered: true, agent: "claude-code", tabId: "tab-1" });
    expect(posted).toEqual([
      { agent: "claude-code", worktreeId: "wt-1", tabId: "tab-1", text: "address the comments" },
    ]);
  });

  it("reports an unattached scratchpad instead of sending", async () => {
    const posted: unknown[] = [];
    const { client } = fsClient({ "plan.mdx": source(null) }, (input, init) => {
      if (!input.endsWith("/v1/agents/inputs")) return null;
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });

    const result = await client.scratchpads.sendAttached({
      root: "/repo",
      filePath: "plan.mdx",
      worktreeId: "wt-1",
      text: "hello",
    });

    expect(result).toEqual({ delivered: false });
    expect(posted).toEqual([]);
  });
});

function clientWithFetch(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}

/**
 * A client whose filesystem RPC is served from an in-memory file map, so the
 * composed scratchpad methods are exercised end to end (read → modify → write).
 * `extra` handles any non-filesystem route the test cares about.
 */
function fsClient(
  initial: Record<string, string>,
  extra: (input: string, init?: RequestInit) => Response | null = () => null,
): { client: PragmaClient; files: Record<string, string> } {
  const files = { ...initial };
  const client = clientWithFetch(async (input, init) => {
    const handled = extra(input, init);
    if (handled) return handled;
    if (!input.endsWith("/v1/rpc/filesystem")) {
      throw new Error(`unexpected request: ${input}`);
    }
    const body = JSON.parse(String(init?.body)) as { op: string; path: string; contents?: string };
    switch (body.op) {
      case "pathExists":
        return Response.json(body.path in files);
      case "readFile":
        return Response.json({ text: files[body.path] ?? "", binary: false, truncated: false });
      case "writeFile":
        files[body.path] = body.contents ?? "";
        return new Response(null, { status: 204 });
      default:
        throw new Error(`unexpected filesystem op: ${body.op}`);
    }
  });
  return { client, files };
}
