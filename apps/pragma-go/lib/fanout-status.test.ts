import type { Fanout, FanoutMember } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import {
  attemptScratchpads,
  fanoutDotStatus,
  fanoutOutcome,
  memberDotStatus,
} from "./fanout-status";

function member(status: FanoutMember["status"]): FanoutMember {
  return {
    id: status,
    ordinal: 0,
    selector: "pragma.codex",
    catalogAgentId: "pragma.codex",
    runtimeAgentId: "codex",
    modelId: null,
    reasoningId: null,
    branch: "fanout/a/b",
    worktreeId: "wt",
    tabId: "tab",
    priorTabIds: [],
    status,
    failure: null,
  };
}

function fanout(...statuses: FanoutMember["status"][]): Fanout {
  return {
    id: "f",
    projectId: "p",
    parentWorktreeId: "parent",
    sourceWorktreeId: null,
    ownsParent: true,
    baseCommit: "abc",
    title: "t",
    prompt: "p",
    status: "active",
    winningMemberId: null,
    finalizeStage: null,
    members: statuses.map(member),
    createdAt: "",
    updatedAt: "",
  };
}

describe("fanout status dots", () => {
  it("maps attempt statuses onto the shared dot", () => {
    expect(memberDotStatus(member("provisioning"))).toBe("running");
    expect(memberDotStatus(member("attention"))).toBe("attention");
    expect(memberDotStatus(member("selected"))).toBe("done");
    expect(memberDotStatus(member("failed"))).toBeNull();
  });

  it("rolls attention over running over done", () => {
    expect(fanoutDotStatus(fanout("done", "attention", "running"))).toBe("attention");
    expect(fanoutDotStatus(fanout("done", "running"))).toBe("running");
    expect(fanoutDotStatus(fanout("done", "failed"))).toBe("done");
    expect(fanoutDotStatus(fanout("failed", "cancelled"))).toBeNull();
  });
});

describe("fanoutOutcome", () => {
  const terminal = (overrides: Partial<Fanout> = {}): Fanout => ({
    ...fanout("done"),
    status: "completed",
    ...overrides,
  });

  it("names the picked winner", () => {
    expect(fanoutOutcome(terminal({ winningMemberId: "done" }))).toBe(
      "codex was picked and merged.",
    );
  });

  it("says a cancelled fanout kept its worktrees", () => {
    expect(fanoutOutcome(terminal({ status: "cancelled" }))).toContain(
      "attempt worktrees were kept",
    );
  });

  it("uses the host's failure, falling back when there is none", () => {
    const failure = { code: "internal" as const, message: "provisioning failed" };
    expect(fanoutOutcome(terminal({ status: "failed", failure }))).toBe("provisioning failed");
    expect(fanoutOutcome(terminal({ status: "failed" }))).toBe("This fanout failed.");
  });
});

function pad(id: string, createdAt: number, agentTabId: string | null = null) {
  return { id, createdAt, agentTabId };
}

describe("attemptScratchpads", () => {
  it("puts the scratchpad attached to the attempt's session first", () => {
    const ordered = attemptScratchpads([pad("new", 3), pad("own", 1, "tab-1")], "tab-1");
    expect(ordered.map((scratchpad) => scratchpad.id)).toEqual(["own", "new"]);
  });

  it("orders the rest newest first", () => {
    const ordered = attemptScratchpads([pad("old", 1), pad("new", 2)], null);
    expect(ordered.map((scratchpad) => scratchpad.id)).toEqual(["new", "old"]);
  });
});
