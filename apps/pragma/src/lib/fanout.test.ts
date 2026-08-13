import type { Fanout, FanoutMember, ScratchpadFile } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import {
  attemptWorktreeIds,
  fanoutForParent,
  fanoutStatusLabel,
  isActiveFanout,
  memberForWorktree,
  memberLabel,
  memberTooltip,
  MIN_COLUMN_WIDTH,
  orderedMembers,
  pairScratchpads,
  resizeColumn,
  unionChangedPaths,
} from "./fanout";

function member(overrides: Partial<FanoutMember> = {}): FanoutMember {
  return {
    id: "m-1",
    ordinal: 0,
    selector: "pragma.opencode",
    catalogAgentId: "pragma.opencode",
    runtimeAgentId: "opencode",
    modelId: "gpt-5.6",
    reasoningId: "high",
    branch: "fanout/aaaa/bbbb",
    worktreeId: "wt-1",
    tabId: "tab-1",
    priorTabIds: [],
    status: "running",
    failure: null,
    ...overrides,
  };
}

function fanout(overrides: Partial<Fanout> = {}): Fanout {
  return {
    id: "f1",
    projectId: "p1",
    parentWorktreeId: "wt-main",
    sourceWorktreeId: null,
    ownsParent: false,
    baseCommit: "aaaa1111",
    title: "Token refresh",
    prompt: "Implement token refresh",
    status: "active",
    winningMemberId: null,
    finalizeStage: null,
    members: [member(), member({ id: "m-2", ordinal: 1, worktreeId: "wt-2", tabId: "tab-2" })],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

describe("fanout relations", () => {
  it("distinguishes a fanout group from ordinary child worktrees", () => {
    const fanouts = [fanout()];
    expect(fanoutForParent(fanouts, "wt-main")?.id).toBe("f1");
    expect(fanoutForParent(fanouts, "wt-other")).toBeNull();
    expect(attemptWorktreeIds(fanouts)).toEqual(new Set(["wt-1", "wt-2"]));
    // An ordinary nested worktree is not an attempt just by having a parent.
    expect(attemptWorktreeIds(fanouts).has("wt-ordinary")).toBe(false);
  });

  it("resolves the fanout and member an attempt worktree belongs to", () => {
    const found = memberForWorktree([fanout()], "wt-2");
    expect(found?.member.id).toBe("m-2");
    expect(found?.fanout.id).toBe("f1");
    expect(memberForWorktree([fanout()], "wt-main")).toBeNull();
  });

  it("drops completed and cancelled fanouts out of the active tree", () => {
    expect(isActiveFanout(fanout({ status: "completed" }))).toBe(false);
    expect(isActiveFanout(fanout({ status: "cancelled" }))).toBe(false);
    expect(isActiveFanout(fanout({ status: "needsResolution" }))).toBe(true);
    expect(fanoutForParent([fanout({ status: "completed" })], "wt-main")).toBeNull();
  });

  it("labels members by harness and model, never by branch", () => {
    expect(memberLabel(member())).toBe("opencode · gpt-5.6");
    expect(memberLabel(member({ modelId: null }))).toBe("opencode");
    expect(memberTooltip(member())).toContain("reasoning high");
    expect(memberTooltip(member({ reasoningId: null }))).toContain("reasoning auto");
    expect(memberLabel(member())).not.toContain("fanout/");
  });

  it("summarizes fanout status for the group row", () => {
    expect(fanoutStatusLabel(fanout({ status: "provisioning" }))).toBe("starting…");
    expect(fanoutStatusLabel(fanout({ status: "attention" }))).toBe("needs input");
    expect(fanoutStatusLabel(fanout({ status: "partial" }))).toBe("partly failed");
    expect(
      fanoutStatusLabel(
        fanout({ members: [member({ status: "done" }), member({ id: "m-2", status: "running" })] }),
      ),
    ).toBe("1/2 done");
  });

  it("keeps members in creation order", () => {
    const shuffled = fanout({
      members: [member({ id: "m-2", ordinal: 1 }), member({ id: "m-1", ordinal: 0 })],
    });
    expect(orderedMembers(shuffled).map((entry) => entry.id)).toEqual(["m-1", "m-2"]);
  });
});

const pad = (overrides: Partial<ScratchpadFile>): ScratchpadFile => ({
  id: "s1",
  title: "Architecture",
  filePath: ".pragma/scratchpads/architecture.mdx",
  contents: "body",
  agentTabId: null,
  agentId: null,
  createdAt: 0,
  ...overrides,
});

describe("scratchpad pairing", () => {
  it("pairs by exact path first", () => {
    const rows = pairScratchpads(
      new Map([
        ["m-1", [pad({})]],
        ["m-2", [pad({ id: "s2", title: "Different title" })]],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.byMember["m-1"]?.id).toBe("s1");
    expect(rows[0]?.byMember["m-2"]?.id).toBe("s2");
  });

  it("falls back to a normalized title when paths differ", () => {
    const rows = pairScratchpads(
      new Map([
        ["m-1", [pad({ filePath: "a/plan.mdx", title: "Refresh Plan" })]],
        ["m-2", [pad({ id: "s2", filePath: "b/notes.mdx", title: "  refresh   plan " })]],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.byMember["m-2"]?.id).toBe("s2");
  });

  it("gives an unmatched scratchpad its own row with empty cells", () => {
    const rows = pairScratchpads(
      new Map([
        ["m-1", [pad({})]],
        ["m-2", []],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.byMember["m-1"]).not.toBeNull();
    expect(rows[0]?.byMember["m-2"]).toBeNull();
  });
});

describe("comparison grid", () => {
  it("builds the union of changed paths across attempts", () => {
    expect(
      unionChangedPaths(
        new Map([
          ["m-1", ["src/a.ts", "src/b.ts"]],
          ["m-2", ["src/b.ts", "src/c.ts"]],
        ]),
      ),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("resizes one shared column model and clamps to a minimum", () => {
    expect(resizeColumn([400, 400], 0, 60)).toEqual([460, 400]);
    expect(resizeColumn([400, 400], 1, -1000)).toEqual([400, MIN_COLUMN_WIDTH]);
  });
});
