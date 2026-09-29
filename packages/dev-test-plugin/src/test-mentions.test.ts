import { describe, expect, it } from "vitest";

import type { PluginContext } from "@pragma-sh/plugin";

import { testMentionsProvider } from "./test-mentions";

const ctx = {} as PluginContext;
const project = { id: "p1", name: "Demo", path: "/tmp/demo" };
const worktree = { id: "w1", path: "/tmp/demo/wt", branch: "feat/x" };

describe("testMentionsProvider", () => {
  it("offers every canned mention", async () => {
    const items = await testMentionsProvider.search(
      { query: "", project, worktree, signal: new AbortController().signal },
      ctx,
    );
    expect(items.map((item) => item.displayName)).toEqual(["dev-hello", "dev-project"]);
  });

  it("resolves the greeting to fixed text", async () => {
    const text = await testMentionsProvider.resolve(
      { item: { id: "hello", displayName: "dev-hello", data: { id: "hello" } }, project, worktree },
      ctx,
    );
    expect(text).toContain("PINEAPPLE");
  });

  it("resolves the project mention from the prompt's project and worktree", async () => {
    const text = await testMentionsProvider.resolve(
      {
        item: { id: "project", displayName: "dev-project", data: { id: "project" } },
        project,
        worktree: null,
      },
      ctx,
    );
    expect(text).toBe("Project: Demo\nWorktree: (none)");
  });
});
