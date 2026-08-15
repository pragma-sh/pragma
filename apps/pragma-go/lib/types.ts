import type {
  AgentAttentionKind,
  AgentMessageRole,
  AgentQuestion,
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
  /** Multiple questions for a `question`; renders the back/next wizard. */
  questions?: AgentQuestion[];
}

/** Normalizes question choices from current and pre-description host payloads. */
export function normalizeQuestionOptions(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap(normalizeQuestionOption);
  return options.length > 0 ? options : undefined;
}

/** Normalizes multi-question attention entries from the wire payload. */
export function normalizeQuestions(value: unknown): AgentQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value.flatMap(normalizeQuestion);
  return questions.length > 0 ? questions : undefined;
}

function normalizeQuestion(question: unknown): AgentQuestion[] {
  if (typeof question === "string") {
    return question.trim() ? [{ question: question.trim(), options: [] }] : [];
  }
  if (!isQuestionObject(question)) return [];
  const text = question.question.trim();
  if (!text) return [];
  const options = normalizeQuestionOptions(question.options) ?? [];
  return [{ question: text, options }];
}

function isQuestionObject(question: unknown): question is { question: string; options?: unknown } {
  return (
    typeof question === "object" &&
    question !== null &&
    "question" in question &&
    typeof (question as { question?: unknown }).question === "string"
  );
}

function normalizeQuestionOption(option: unknown): QuestionOption[] {
  if (typeof option === "string") return optionFromLabel(option);
  if (!isQuestionOption(option)) return [];
  return optionFromParts(option.label, option.description);
}

function isQuestionOption(option: unknown): option is { label: unknown; description?: unknown } {
  return typeof option === "object" && option !== null && "label" in option;
}

function optionFromLabel(label: string): QuestionOption[] {
  return optionFromParts(label, undefined);
}

function optionFromParts(label: unknown, description: unknown): QuestionOption[] {
  if (typeof label !== "string" || !label.trim()) return [];
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  return [
    { label: label.trim(), ...(trimmedDescription ? { description: trimmedDescription } : {}) },
  ];
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
