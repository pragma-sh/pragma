import type {
  AgentAttentionKind,
  AgentMessageRole,
  AgentStatus,
  Project,
  QuestionOption,
  Worktree,
} from "@pragma/constants";

// Re-export the shared domain types so screens import them from one place while
// keeping @pragma/constants the single source of truth.
export type { AgentAttentionKind, AgentMessageRole, AgentStatus, Project, Worktree };

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

/**
 * A live command/question the agent is blocked on, surfaced in the chat
 * AttentionDock. Derived from `type:"agent"` stream events with an
 * `attentionKind`; cleared when a matching decision/answer echoes back.
 */
export interface AttentionRequest {
  kind: AgentAttentionKind;
  /** Correlation id used to match the resolving decision/answer echo. */
  requestId: string;
  /** The command to approve/deny, or the question being asked. */
  prompt: string;
  /** Answer choices for a `question`; empty for a `command`. */
  options?: QuestionOption[];
}

/** Normalizes question choices from current and pre-description host payloads. */
export function normalizeQuestionOptions(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((option): QuestionOption[] => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ label }] : [];
    }
    if (typeof option !== "object" || option === null || !("label" in option)) return [];
    const { label, description } = option;
    if (typeof label !== "string" || !label.trim()) return [];
    return [
      {
        label: label.trim(),
        ...(typeof description === "string" && description.trim()
          ? { description: description.trim() }
          : {}),
      },
    ];
  });
  return options.length > 0 ? options : undefined;
}

/**
 * One rendered line in the chat transcript. `message` rows carry
 * assistant/user/system prose; `event` rows are the gray activity lines
 * (tool calls, file edits, spawned sub-agents).
 */
export type TranscriptRow =
  | { kind: "message"; id: string; role: AgentMessageRole; text: string; ts: number }
  | {
      kind: "event";
      id: string;
      text: string;
      ts: number;
      /** Structured tool-call metadata when the event is a tool activity line. */
      tool?: { name: string; status: string; summary?: string };
    };

/** Lifecycle phase of the chat's agent connection. */
export type ChatConnectionState = "connecting" | "open" | "empty" | "error";

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
  options?: QuestionOption[];
  /** Hosting tab id — carried on live items so a decision/answer can be routed. */
  tabId?: string;
  /** Correlation id — carried on live items so the reply matches the request. */
  requestId?: string;
}
