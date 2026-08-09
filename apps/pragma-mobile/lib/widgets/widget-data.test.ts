import { describe, expect, it } from "vitest";

import type { AgentStatus, AgentTab, InboxItem, Project, Worktree } from "../types";
import {
  buildWidgetSnapshot,
  emptyWidgetSnapshot,
  statusColor,
  WIDGET_INBOX_LIMIT,
  WIDGET_PROJECT_LIMIT,
  WIDGET_WORKTREE_LIMIT,
  type WidgetLinks,
} from "./widget-data";

const links: WidgetLinks = {
  inbox: "pragma:///inbox",
  project: (projectId) => `pragma:///project/${projectId}`,
  worktree: (worktreeId) => `pragma:///worktree/${worktreeId}`,
};

function project(id: string, name = id): Project {
  return { id, name, path: `/tmp/${id}`, orderIndex: 0 } as Project;
}

function worktree(id: string, projectId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId,
    branch: id,
    path: `/tmp/${projectId}/${id}`,
    isMain: false,
    ...overrides,
  } as Worktree;
}

function tab(id: string, worktreeId: string, status: AgentStatus): AgentTab {
  return { id, worktreeId, agent: "claude", title: id, status, attentionKind: null };
}

function inboxItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    kind: "command",
    projectId: "p1",
    projectName: "pragma",
    worktreeId: "w1",
    worktreeLabel: "main",
    agent: "claude",
    prompt: "rm -rf build",
    ...overrides,
  };
}

function snapshotOf(overrides: {
  paired?: boolean;
  projects?: Project[];
  agentTabs?: Record<string, AgentTab[]>;
  inbox?: InboxItem[];
  worktrees?: Worktree[];
}) {
  return buildWidgetSnapshot({
    paired: overrides.paired ?? true,
    projects: overrides.projects ?? [],
    worktrees: overrides.worktrees ?? [],
    agentTabs: overrides.agentTabs ?? {},
    inbox: overrides.inbox ?? [],
    links,
    now: 1000,
  });
}

describe("buildWidgetSnapshot", () => {
  it("returns the empty snapshot when unpaired", () => {
    expect(snapshotOf({ paired: false, inbox: [inboxItem("i1")] })).toEqual(
      emptyWidgetSnapshot(links, 1000),
    );
  });

  it("buckets every agent into exactly one of the three counters", () => {
    const snapshot = snapshotOf({
      agentTabs: {
        w1: [tab("t1", "w1", "running"), tab("t2", "w1", "attention")],
        w2: [tab("t3", "w2", "done"), tab("t4", "w2", "cleared")],
      },
    });

    // `cleared` counts as idle alongside `done`.
    expect(snapshot.counts).toEqual({ working: 1, attention: 1, done: 2, total: 4 });
  });

  it("caps the inbox rows but reports the full pending total", () => {
    const items = Array.from({ length: WIDGET_INBOX_LIMIT + 3 }, (_, index) =>
      inboxItem(`i${index}`),
    );

    const snapshot = snapshotOf({ inbox: items });

    expect(snapshot.inbox).toHaveLength(WIDGET_INBOX_LIMIT);
    expect(snapshot.inboxTotal).toBe(items.length);
  });

  it("flattens an inbox item into a widget row", () => {
    const snapshot = snapshotOf({
      inbox: [
        inboxItem("i1", {
          kind: "question",
          prompt: "  Which  branch\nshould I use?  ",
          worktreeLabel: "feat/x",
        }),
      ],
    });

    expect(snapshot.inbox[0]).toEqual({
      id: "i1",
      kind: "question",
      symbol: "questionmark.circle.fill",
      agent: "claude",
      location: "pragma / feat/x",
      prompt: "Which branch should I use?",
      url: links.inbox,
    });
  });

  it("truncates a long prompt", () => {
    const snapshot = snapshotOf({ inbox: [inboxItem("i1", { prompt: "x".repeat(200) })] });

    expect(snapshot.inbox[0]?.prompt).toHaveLength(90);
    expect(snapshot.inbox[0]?.prompt.endsWith("…")).toBe(true);
  });

  it("rolls project status up from every worktree in the project", () => {
    const snapshot = snapshotOf({
      projects: [project("p1", "pragma"), project("p2", "docs")],
      worktrees: [
        worktree("w1", "p1", { isMain: true, branch: "main" }),
        worktree("w2", "p1"),
        worktree("w3", "p2"),
      ],
      agentTabs: {
        w1: [tab("t1", "w1", "done")],
        w2: [tab("t2", "w2", "attention")],
        w3: [tab("t3", "w3", "running")],
      },
    });

    const rollups = snapshot.projects.map((entry) => ({
      id: entry.id,
      name: entry.name,
      color: entry.color,
      agents: entry.agents,
      url: entry.url,
    }));

    expect(rollups).toEqual([
      { id: "p1", name: "pragma", color: "red", agents: 2, url: "pragma:///project/p1" },
      { id: "p2", name: "docs", color: "orange", agents: 1, url: "pragma:///project/p2" },
    ]);
  });

  it("lists a project's worktrees main-first, as the app's tree orders them", () => {
    const snapshot = snapshotOf({
      projects: [project("p1", "pragma")],
      worktrees: [
        worktree("w2", "p1", { title: "mobile-widgets" }),
        worktree("w1", "p1", { isMain: true, branch: "main" }),
      ],
      agentTabs: {
        w1: [tab("t1", "w1", "done")],
        w2: [tab("t2", "w2", "running")],
      },
    });

    expect(snapshot.projects[0]?.worktrees).toEqual([
      {
        id: "w1",
        name: "main",
        color: "green",
        depth: 0,
        agents: 1,
        url: "pragma:///worktree/w1",
      },
      {
        id: "w2",
        name: "mobile-widgets",
        color: "orange",
        depth: 0,
        agents: 1,
        url: "pragma:///worktree/w2",
      },
    ]);
  });

  it("keeps only worktrees that are active or hold an unviewed result", () => {
    const snapshot = snapshotOf({
      projects: [project("p1", "pragma")],
      worktrees: [worktree("w1", "p1"), worktree("w2", "p1"), worktree("w3", "p1")],
      agentTabs: {
        // `cleared` is a viewed (or never reporting) agent: not news.
        w1: [tab("t1", "w1", "cleared")],
        w2: [tab("t2", "w2", "running")],
        w3: [tab("t3", "w3", "done")],
      },
    });

    expect(snapshot.projects[0]?.worktrees.map((entry) => entry.id)).toEqual(["w2", "w3"]);
    expect(snapshot.projects[0]?.agents).toBe(2);
  });

  it("keeps an idle parent that holds a live child, nested beneath it", () => {
    const snapshot = snapshotOf({
      projects: [project("p1", "pragma")],
      worktrees: [
        worktree("w1", "p1", { isMain: true, branch: "main" }),
        worktree("w2", "p1", { parentId: "w1", title: "parent" }),
        worktree("w3", "p1", { parentId: "w2", title: "child" }),
      ],
      agentTabs: { w3: [tab("t1", "w3", "attention")] },
    });

    expect(snapshot.projects[0]?.worktrees).toEqual([
      { id: "w2", name: "parent", color: "red", depth: 0, agents: 0, url: "pragma:///worktree/w2" },
      { id: "w3", name: "child", color: "red", depth: 1, agents: 1, url: "pragma:///worktree/w3" },
    ]);
  });

  it("lists main as a flat row, never a parent of its worktrees", () => {
    const snapshot = snapshotOf({
      projects: [project("p1", "pragma")],
      worktrees: [
        worktree("w1", "p1", { isMain: true, branch: "main" }),
        worktree("w2", "p1", { parentId: "w1", title: "child" }),
      ],
      agentTabs: { w1: [tab("t0", "w1", "running")], w2: [tab("t1", "w2", "attention")] },
    });

    expect(snapshot.projects[0]?.worktrees).toEqual([
      {
        id: "w1",
        name: "main",
        color: "orange",
        depth: 0,
        agents: 1,
        url: "pragma:///worktree/w1",
      },
      { id: "w2", name: "child", color: "red", depth: 0, agents: 1, url: "pragma:///worktree/w2" },
    ]);
  });

  it("drops projects with no live worktrees and caps the rest", () => {
    const projects = Array.from({ length: WIDGET_PROJECT_LIMIT + 2 }, (_, index) =>
      project(`p${index}`),
    );
    const worktrees = projects.map((entry, index) => worktree(`w${index}`, entry.id));
    const agentTabs = Object.fromEntries(
      projects
        .slice(1)
        .map((_, index) => [`w${index + 1}`, [tab(`t${index}`, `w${index + 1}`, "running")]]),
    );

    const snapshot = snapshotOf({ projects, worktrees, agentTabs });

    expect(snapshot.projects).toHaveLength(WIDGET_PROJECT_LIMIT);
    expect(snapshot.projects.map((entry) => entry.id)).not.toContain("p0");
  });

  it("caps the worktree rows carried across all projects", () => {
    const count = WIDGET_WORKTREE_LIMIT + 3;
    const projects = [project("p1")];
    const worktrees = Array.from({ length: count }, (_, index) => worktree(`w${index}`, "p1"));
    const agentTabs = Object.fromEntries(
      worktrees.map((entry, index) => [entry.id, [tab(`t${index}`, entry.id, "running")]]),
    );

    const snapshot = snapshotOf({ projects, worktrees, agentTabs });

    expect(snapshot.projects[0]?.worktrees).toHaveLength(WIDGET_WORKTREE_LIMIT);
    // The project count still reports every agent, not just the carried rows.
    expect(snapshot.projects[0]?.agents).toBe(count);
  });
});

describe("statusColor", () => {
  it("matches the app's status dot palette", () => {
    expect(statusColor("attention")).toBe("red");
    expect(statusColor("running")).toBe("orange");
    expect(statusColor("done")).toBe("green");
    expect(statusColor("cleared")).toBe("gray");
    expect(statusColor(null)).toBe("gray");
  });
});
