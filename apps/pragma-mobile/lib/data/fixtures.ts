import type { AgentTab, InboxItem, Project, Worktree } from "../types";

// Front-end-only mock data. Swap this module out (or replace the provider's
// source) once the app server is wired in — the shape mirrors the desktop's
// SQLite rows plus the derived agent/inbox views.

const now = "2026-07-05T12:00:00.000Z";

export const MOCK_PROJECTS: Project[] = [
  { id: "proj-pragma", name: "pragma", path: "/Users/dev/pragma", orderIndex: 0, createdAt: now },
  { id: "proj-web", name: "acme-web", path: "/Users/dev/acme-web", orderIndex: 1, createdAt: now },
  {
    id: "proj-infra",
    name: "infra",
    path: "/Users/dev/infra",
    orderIndex: 2,
    createdAt: now,
  },
];

// Flat worktree rows. `parentId` builds the nesting the sidebar tree renders.
// main is a top-level sibling of the feature branches, not their parent — only
// true sub-branches (branched off another branch) nest.
export const MOCK_WORKTREES: Worktree[] = [
  // pragma
  wt("wt-pragma-main", "proj-pragma", null, "main", null, true),
  wt("wt-pragma-mobile", "proj-pragma", null, "mobile-app-frontend", "Mobile app"),
  wt("wt-pragma-lag", "proj-pragma", null, "lag-fixes", "Lag fixes"),
  wt("wt-pragma-lag-poll", "proj-pragma", "wt-pragma-lag", "lag/polling", "Polling tweak"),
  wt("wt-pragma-lag-git", "proj-pragma", "wt-pragma-lag", "lag/git-concurrency", "Git concurrency"),
  // acme-web
  wt("wt-web-main", "proj-web", null, "main", null, true),
  wt("wt-web-checkout", "proj-web", null, "feat/checkout-v2", "Checkout v2"),
  wt("wt-web-a11y", "proj-web", null, "fix/a11y-audit", "A11y audit"),
  // infra
  wt("wt-infra-main", "proj-infra", null, "main", null, true),
];

function wt(
  id: string,
  projectId: string,
  parentId: string | null,
  branch: string,
  title: string | null,
  isMain = false,
): Worktree {
  return {
    id,
    projectId,
    parentId,
    branch,
    title,
    path: `/tmp/${id}`,
    isMain,
    hidden: false,
    createdAt: now,
  };
}

// Agent tabs per worktree id. Absent ids simply have no agents (no status dot).
export const MOCK_AGENT_TABS: Record<string, AgentTab[]> = {
  "wt-pragma-mobile": [
    tab("tab-mob-claude", "wt-pragma-mobile", "claude", "Claude", "running", null),
    tab("tab-mob-cursor", "wt-pragma-mobile", "cursor", "Cursor", "done", null),
  ],
  "wt-pragma-lag-poll": [
    tab("tab-poll-claude", "wt-pragma-lag-poll", "claude", "Claude", "attention", "command"),
  ],
  "wt-pragma-lag-git": [
    tab("tab-git-oc", "wt-pragma-lag-git", "opencode", "opencode", "done", null),
  ],
  "wt-web-checkout": [
    tab("tab-co-claude", "wt-web-checkout", "claude", "Claude", "attention", "question"),
    tab("tab-co-cursor", "wt-web-checkout", "cursor", "Cursor", "running", null),
  ],
  "wt-web-a11y": [tab("tab-a11y-oc", "wt-web-a11y", "opencode", "opencode", "running", null)],
};

function tab(
  id: string,
  worktreeId: string,
  agent: string,
  title: string,
  status: AgentTab["status"],
  attentionKind: AgentTab["attentionKind"],
): AgentTab {
  return { id, worktreeId, agent, title, status, attentionKind };
}

export const MOCK_INBOX: InboxItem[] = [
  {
    id: "inbox-1",
    kind: "command",
    projectId: "proj-pragma",
    projectName: "pragma",
    worktreeId: "wt-pragma-lag-poll",
    worktreeLabel: "Polling tweak",
    agent: "claude",
    prompt: "Run the reduced-render benchmark?",
    detail: "bun run --filter pragma bench:render --iterations 200",
  },
  {
    id: "inbox-2",
    kind: "question",
    projectId: "proj-web",
    projectName: "acme-web",
    worktreeId: "wt-web-checkout",
    worktreeLabel: "Checkout v2",
    agent: "claude",
    prompt: "Which state library should the new checkout flow use?",
    options: ["Zustand", "Redux Toolkit", "React Context only"],
  },
  {
    id: "inbox-3",
    kind: "command",
    projectId: "proj-web",
    projectName: "acme-web",
    worktreeId: "wt-web-a11y",
    worktreeLabel: "A11y audit",
    agent: "opencode",
    prompt: "Apply the suggested ARIA-label patch to 6 files?",
    detail: "git apply .pragma/patches/a11y-labels.patch",
  },
  {
    id: "inbox-4",
    kind: "question",
    projectId: "proj-pragma",
    projectName: "pragma",
    worktreeId: "wt-pragma-mobile",
    worktreeLabel: "Mobile app",
    agent: "cursor",
    prompt: "Target the iOS liquid-glass tab bar or a portable blur fallback first?",
    options: ["Liquid glass (iOS 26)", "Blur fallback", "Both, feature-detected"],
  },
];
