import { describe, expect, it } from "vitest";

import type { AgentModelSelection } from "./data/agents";
import {
  buildLaunchPayload,
  initialLaunchForm,
  type LaunchFormState,
  newBranchFields,
  runInFor,
  runtimeAgentId,
  targetForRunIn,
} from "./launch-form";

const selection: AgentModelSelection = { agentId: "claude", modelId: "opus", reasoningId: "high" };
const context = { projectId: "p1", worktreeId: "w1" };

describe("runtimeAgentId", () => {
  it("removes a catalog namespace", () => {
    expect(runtimeAgentId("pragma.opencode")).toBe("opencode");
  });

  it("preserves an unqualified id", () => {
    expect(runtimeAgentId("opencode")).toBe("opencode");
  });
});

function form(over: Partial<LaunchFormState> = {}): LaunchFormState {
  return { ...initialLaunchForm(selection), ...over };
}

describe("buildLaunchPayload", () => {
  it("requires an agent selection", () => {
    const result = buildLaunchPayload(form({ selection: null }), context);
    expect(result.ok).toBe(false);
  });

  it("launches into the current worktree", () => {
    const result = buildLaunchPayload(form({ prompt: "  do it  " }), context);
    expect(result).toEqual({
      ok: true,
      payload: {
        projectId: "p1",
        agentId: "claude",
        modelId: "opus",
        reasoningId: "high",
        prompt: "do it",
        worktreeId: "w1",
        newWorktree: null,
      },
    });
  });

  it("nulls an empty prompt and a missing model", () => {
    const result = buildLaunchPayload(
      form({ selection: { agentId: "a", modelId: "", reasoningId: null }, prompt: "" }),
      context,
    );
    expect(result.ok && result.payload.prompt).toBeNull();
    expect(result.ok && result.payload.modelId).toBeNull();
  });

  it("builds a new-worktree spec parented to the current worktree", () => {
    const result = buildLaunchPayload(
      form({ target: { kind: "new", branch: " feat/x ", title: " Title " } }),
      context,
    );
    expect(result.ok && result.payload).toMatchObject({
      worktreeId: null,
      newWorktree: { parentWorktreeId: "w1", branch: "feat/x", title: "Title" },
    });
  });

  it("requires a branch name for a new worktree", () => {
    const result = buildLaunchPayload(
      form({ target: { kind: "new", branch: "  ", title: "" } }),
      context,
    );
    expect(result.ok).toBe(false);
  });

  it("nulls an empty new-worktree title", () => {
    const result = buildLaunchPayload(
      form({ target: { kind: "new", branch: "b", title: "  " } }),
      context,
    );
    expect(result.ok && result.payload.newWorktree?.title).toBeNull();
  });
});

describe("run-in switching", () => {
  it("shows the fanout tab while attempts exist", () => {
    expect(runInFor({ kind: "existing" }, true)).toBe("fanout");
    expect(runInFor({ kind: "new", branch: "b", title: "" }, false)).toBe("new");
  });

  it("keeps a typed branch between new branch and fan out", () => {
    const typed = { kind: "new" as const, branch: "token-refresh", title: "T" };
    expect(targetForRunIn("fanout", typed)).toEqual({
      kind: "new",
      branch: "token-refresh",
      title: "",
    });
    expect(targetForRunIn("new", { kind: "existing" })).toEqual({
      kind: "new",
      branch: "",
      title: "",
    });
    expect(targetForRunIn("existing", typed)).toEqual({ kind: "existing" });
  });

  it("reads branch fields only from a new-branch target", () => {
    expect(newBranchFields({ kind: "existing" })).toEqual({ branch: "", title: "" });
    expect(newBranchFields({ kind: "new", branch: "b", title: "t" })).toEqual({
      branch: "b",
      title: "t",
    });
  });
});
