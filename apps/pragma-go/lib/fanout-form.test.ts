import { PragmaGatewayError } from "@pragma-sh/sdk";
import { describe, expect, it } from "vitest";

import {
  buildFanoutRequest,
  fanoutFailureMessage,
  followUpSummary,
  followUpTarget,
  initialAttempts,
  isCleanPick,
  MIN_FANOUT_ATTEMPTS,
  newAttempt,
  pickNotice,
  summarizeReceipts,
  type FanoutFormState,
} from "./fanout-form";

const opus = { agentId: "pragma.claude-code", modelId: "opus", reasoningId: "high" };
const codex = { agentId: "pragma.codex", modelId: "", reasoningId: null };
const context = { projectId: "p1", worktreeId: "wt-main" };

function form(overrides: Partial<FanoutFormState> = {}): FanoutFormState {
  return {
    prompt: "Add token refresh",
    branch: "token-refresh",
    title: "",
    attempts: [newAttempt(opus), newAttempt(codex)],
    ...overrides,
  };
}

describe("initialAttempts", () => {
  it("repeats the current selection up to the member floor with distinct keys", () => {
    const attempts = initialAttempts(opus);
    expect(attempts).toHaveLength(MIN_FANOUT_ATTEMPTS);
    expect(new Set(attempts.map((attempt) => attempt.key)).size).toBe(attempts.length);
    expect(attempts.every((attempt) => attempt.selection === opus)).toBe(true);
  });
});

describe("buildFanoutRequest", () => {
  it("branches a new coordination parent and maps each attempt", () => {
    const result = buildFanoutRequest(form({ title: "  Refresh  " }), context);
    expect(result).toEqual({
      ok: true,
      request: {
        projectId: "p1",
        parent: {
          kind: "new",
          sourceWorktreeId: "wt-main",
          branch: "token-refresh",
          title: "Refresh",
        },
        prompt: "Add token refresh",
        defaultReasoningId: null,
        members: [
          { selector: "pragma.claude-code", modelId: "opus", reasoningId: "high" },
          { selector: "pragma.codex", modelId: null, reasoningId: null },
        ],
      },
    });
  });

  it("requires a prompt, a branch, and an agent on every row", () => {
    expect(buildFanoutRequest(form({ prompt: "  " }), context).ok).toBe(false);
    expect(buildFanoutRequest(form({ branch: "" }), context).ok).toBe(false);
    expect(
      buildFanoutRequest(form({ attempts: [newAttempt(opus), newAttempt(null)] }), context),
    ).toEqual({ ok: false, reason: "Choose an agent for every attempt." });
  });

  it("refuses fewer attempts than the host's floor", () => {
    const result = buildFanoutRequest(form({ attempts: [newAttempt(opus)] }), context);
    expect(result.ok).toBe(false);
  });
});

describe("fanoutFailureMessage", () => {
  it("prefers the host's fanout failure message", () => {
    const error = new PragmaGatewayError("request failed", {
      code: "conflict",
      httpStatus: 409,
      details: { code: "dirtyParent", message: "the parent worktree has uncommitted changes" },
    });
    expect(fanoutFailureMessage(error, "fallback")).toBe(
      "the parent worktree has uncommitted changes",
    );
  });

  it("falls back for errors that carry nothing useful", () => {
    expect(fanoutFailureMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});

describe("follow-ups", () => {
  it("targets the attempt in view only when there is one", () => {
    expect(followUpTarget("member", "m-1")).toEqual({ kind: "member", memberId: "m-1" });
    expect(followUpTarget("member", undefined)).toEqual({ kind: "all" });
    expect(followUpTarget("all", "m-1")).toEqual({ kind: "all" });
  });

  it("summarises delivery", () => {
    expect(followUpSummary({ delivered: 1, failed: 0 })).toBe("Sent to 1 attempt.");
    expect(followUpSummary({ delivered: 3, failed: 0 })).toBe("Sent to 3 attempts.");
    expect(followUpSummary({ delivered: 2, failed: 1 })).toBe("Sent to 2; 1 did not take it.");
  });
});

const receipt = (state: "accepted" | "delivered" | "failed" | "timedOut") => ({
  memberId: state,
  worktreeId: "wt",
  tabId: "tab",
  runtimeAgentId: "codex",
  messageId: "msg",
  state,
});

const pick = (overrides: Record<string, unknown>) =>
  ({
    fanout: { status: "completed" },
    stage: "completed",
    winningMemberId: "m-1",
    promotedScratchpads: [],
    deletedWorktreeIds: [],
    survivingWorktreeIds: [],
    failures: [],
    ...overrides,
  }) as unknown as Parameters<typeof pickNotice>[0];

describe("send and pick outcomes", () => {
  it("counts failed and timed-out receipts as not delivered", () => {
    expect(
      summarizeReceipts([receipt("delivered"), receipt("accepted"), receipt("timedOut")]),
    ).toEqual({ delivered: 2, failed: 1 });
  });

  it("treats only a completed pick with nothing left over as clean", () => {
    expect(isCleanPick(pick({}))).toBe(true);
    expect(isCleanPick(pick({ survivingWorktreeIds: ["wt-2"] }))).toBe(false);
    expect(isCleanPick(pick({ stage: "merging" }))).toBe(false);
  });

  it("explains a pick that stopped short", () => {
    expect(pickNotice(pick({ fanout: { status: "needsResolution" } }))?.title).toBe(
      "Merge conflict",
    );
    expect(pickNotice(pick({ survivingWorktreeIds: ["a", "b"] }))?.message).toContain("2 attempt");
    expect(pickNotice(pick({ failures: [{ code: "internal", message: "boom" }] }))).toEqual({
      title: "Pick stopped",
      message: "boom",
    });
    expect(pickNotice(pick({}))).toBeNull();
  });
});
