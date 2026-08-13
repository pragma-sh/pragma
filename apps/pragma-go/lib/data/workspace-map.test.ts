import type { AgentReportPayload, Project, Tab, Worktree } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import {
  agentTabsBySnapshot,
  inboxFromStatuses,
  markTabStatusesSeen,
  parseAgentStatuses,
} from "./workspace-map";

const project: Project = {
  id: "p1",
  name: "pragma",
  path: "/x",
  orderIndex: 0,
  createdAt: "t",
};

function worktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: "w1",
    projectId: "p1",
    parentId: null,
    branch: "feature",
    title: "Feature",
    path: "/x/w1",
    isMain: false,
    hidden: false,
    createdAt: "t",
    ...over,
  };
}

function tab(over: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    projectId: "p1",
    worktreeId: "w1",
    kind: "terminal",
    title: "Claude",
    url: null,
    filePath: null,
    diffSide: null,
    diffCommit: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    agentId: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "t",
    ...over,
  };
}

function status(over: Partial<AgentReportPayload> = {}): AgentReportPayload {
  return { agent: "claude", worktreeId: "w1", tabId: "t1", status: "running", ...over };
}

describe("agentTabsBySnapshot", () => {
  it("overlays status onto the matching tab and groups by worktree", () => {
    const map = agentTabsBySnapshot(
      [tab({ id: "t1", title: "Claude" })],
      [status({ tabId: "t1", status: "attention", attentionKind: "command" })],
    );
    expect(map).toEqual({
      w1: [
        {
          id: "t1",
          worktreeId: "w1",
          agent: "claude",
          title: "Claude",
          status: "attention",
          attentionKind: "command",
        },
      ],
    });
  });

  it("includes an open agent tab with no status report, dotless", () => {
    const map = agentTabsBySnapshot(
      [tab({ id: "t1", agentId: "pragma.claude", title: "Claude" })],
      [],
    );
    expect(map).toEqual({
      w1: [
        {
          id: "t1",
          worktreeId: "w1",
          agent: "claude",
          title: "Claude",
          status: "cleared",
          attentionKind: null,
        },
      ],
    });
  });

  it("reduces a third-party catalog-qualified agent id to its runtime id", () => {
    const map = agentTabsBySnapshot([tab({ agentId: "acme.myagent" })], []);
    expect(map.w1?.[0]?.agent).toBe("myagent");
  });

  it("shows a manually started agent known only by a status-less report", () => {
    const map = agentTabsBySnapshot(
      [tab({ id: "t1", title: "refactor auth" })],
      [status({ tabId: "t1", status: null })],
    );
    expect(map.w1).toEqual([
      {
        id: "t1",
        worktreeId: "w1",
        agent: "claude",
        title: "refactor auth",
        status: "cleared",
        attentionKind: null,
      },
    ]);
  });

  it("rolls several reports on one tab up to the most urgent status", () => {
    const map = agentTabsBySnapshot(
      [tab({ id: "t1" })],
      [
        status({ tabId: "t1", agent: "claude", status: "done" }),
        status({ tabId: "t1", agent: "claude", status: "attention", attentionKind: "question" }),
      ],
    );
    expect(map.w1).toHaveLength(1);
    expect(map.w1?.[0]).toMatchObject({ status: "attention", attentionKind: "question" });
  });

  it("drops reports whose tab is no longer open", () => {
    expect(agentTabsBySnapshot([], [status({ tabId: "gone" })])).toEqual({});
  });

  it("omits plain shell tabs with no agent and no report", () => {
    expect(agentTabsBySnapshot([tab()], [])).toEqual({});
  });

  it("omits non-terminal tabs even when tagged with an agent", () => {
    expect(agentTabsBySnapshot([tab({ kind: "editor", agentId: "pragma.claude" })], [])).toEqual(
      {},
    );
  });

  it("prefers a live terminal title over the workspace snapshot", () => {
    const map = agentTabsBySnapshot([tab({ title: "Shell" })], [status()], {
      t1: "Implement mobile session titles",
    });

    expect(map.w1?.[0]?.title).toBe("Implement mobile session titles");
  });

  it("orders agents from newest to oldest tab", () => {
    const map = agentTabsBySnapshot(
      [
        tab({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
        tab({ id: "new", createdAt: "2026-01-02T00:00:00Z" }),
      ],
      [status({ tabId: "old" }), status({ tabId: "new" })],
    );

    expect(map.w1?.map((agent) => agent.id)).toEqual(["new", "old"]);
  });
});

describe("inboxFromStatuses", () => {
  it("builds a command item with routing fields", () => {
    const items = inboxFromStatuses(
      [
        status({
          status: "attention",
          attentionKind: "command",
          command: "rm -rf x",
          requestId: "r1",
        }),
      ],
      [project],
      [worktree()],
      [tab()],
    );
    expect(items).toEqual([
      {
        id: "t1:claude:r1",
        kind: "command",
        projectId: "p1",
        projectName: "pragma",
        worktreeId: "w1",
        worktreeLabel: "Feature",
        agent: "claude",
        prompt: "rm -rf x",
        detail: "rm -rf x",
        tabId: "t1",
        requestId: "r1",
      },
    ]);
  });

  it("builds a question item without a detail line", () => {
    const items = inboxFromStatuses(
      [
        status({
          status: "attention",
          attentionKind: "question",
          question: "Which?",
          requestId: "r2",
        }),
      ],
      [project],
      [worktree()],
      [tab()],
    );
    expect(items[0]).toMatchObject({ kind: "question", prompt: "Which?" });
    expect(items[0]?.detail).toBeUndefined();
  });

  it("forwards answer options on a question item", () => {
    const items = inboxFromStatuses(
      [
        status({
          status: "attention",
          attentionKind: "question",
          question: "Which?",
          options: [{ label: "A", description: "First choice" }, { label: "B" }],
          requestId: "r3",
        }),
      ],
      [project],
      [worktree()],
      [tab()],
    );
    expect(items[0]).toMatchObject({
      kind: "question",
      prompt: "Which?",
      options: [{ label: "A", description: "First choice" }, { label: "B" }],
    });
  });

  it("normalizes legacy string answer options from an older host", () => {
    const items = inboxFromStatuses(
      [
        status({
          status: "attention",
          attentionKind: "question",
          question: "Which?",
          options: ["A", "B"] as never,
          requestId: "r4",
        }),
      ],
      [project],
      [worktree()],
      [tab()],
    );
    expect(items[0]?.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  it("skips non-attention statuses and attention without a requestId", () => {
    const items = inboxFromStatuses(
      [
        status({ status: "running" }),
        status({ status: "attention", attentionKind: "command", command: "x" }),
      ],
      [project],
      [worktree()],
      [tab()],
    );
    expect(items).toHaveLength(0);
  });

  it("orders items from newest to oldest tab", () => {
    const items = inboxFromStatuses(
      [
        status({ tabId: "old", status: "attention", attentionKind: "command", requestId: "r1" }),
        status({ tabId: "new", status: "attention", attentionKind: "command", requestId: "r2" }),
      ],
      [project],
      [worktree()],
      [
        tab({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
        tab({ id: "new", createdAt: "2026-01-02T00:00:00Z" }),
      ],
    );

    expect(items.map((item) => item.tabId)).toEqual(["new", "old"]);
  });
});

describe("parseAgentStatuses", () => {
  it("accepts a bare array", () => {
    expect(parseAgentStatuses([status()])).toHaveLength(1);
  });

  it("accepts a { statuses } or { agents } wrapper", () => {
    expect(parseAgentStatuses({ statuses: [status()] })).toHaveLength(1);
    expect(parseAgentStatuses({ agents: [status()] })).toHaveLength(1);
  });

  it("drops malformed entries and unknown shapes", () => {
    expect(parseAgentStatuses([{ agent: "x" }, status()])).toHaveLength(1);
    expect(parseAgentStatuses("nope")).toEqual([]);
    expect(parseAgentStatuses(null)).toEqual([]);
  });

  it("keeps status-less session-name reports", () => {
    expect(parseAgentStatuses([status({ status: null, sessionName: "refactor" })])).toHaveLength(1);
  });
});

describe("markTabStatusesSeen", () => {
  it("clears only completed reports for the viewed tab", () => {
    const running = status({ tabId: "viewed", status: "running" });
    const other = status({ tabId: "other", status: "done" });

    expect(markTabStatusesSeen([status({ status: "done" }), running, other], "t1")).toEqual([
      status({ status: "cleared" }),
      running,
      other,
    ]);
  });
});
