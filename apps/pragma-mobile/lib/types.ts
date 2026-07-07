import type { AgentAttentionKind, AgentStatus, Project, Worktree } from "@pragma/constants";

// Re-export the shared domain types so screens import them from one place while
// keeping @pragma/constants the single source of truth.
export type { AgentAttentionKind, AgentStatus, Project, Worktree };

/**
 * An agent-hosting tab within a worktree. On the desktop this is a terminal tab
 * an external agent reports status through; on mobile it is a chat surface.
 */
export interface AgentTab {
  id: string;
  worktreeId: string;
  /** Agent name, e.g. "claude", "opencode", "cursor". */
  agent: string;
  /** Human label for the tab (falls back to the agent name). */
  title: string;
  status: AgentStatus;
  /** Why the agent needs attention, when `status === "attention"`. */
  attentionKind: AgentAttentionKind | null;
}

/** An item awaiting the user in the Inbox tab. */
export interface InboxItem {
  id: string;
  kind: AgentAttentionKind;
  projectId: string;
  projectName: string;
  worktreeId: string;
  worktreeLabel: string;
  agent: string;
  /** The command to approve/deny, or the question being asked. */
  prompt: string;
  /** Extra detail line (e.g. the shell command for a command request). */
  detail?: string;
  /** Answer choices for a `question`; empty/undefined for a `command`. */
  options?: string[];
}
