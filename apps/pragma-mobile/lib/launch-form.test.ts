import { describe, expect, it } from "vitest";

import type { AgentModelSelection } from "./data/agents";
import {
  buildLaunchPayload,
  initialLaunchForm,
  runtimeAgentId,
  type LaunchFormState,
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
