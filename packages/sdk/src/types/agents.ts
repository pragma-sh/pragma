import type {
  AgentAnswer,
  AgentAttentionKind,
  AgentCatalog,
  AgentDecision,
  AgentIcon,
  AgentInput,
  AgentInterrupt,
  AgentMessage,
  AgentModelEntry,
  QuestionOption,
  AgentReasoning,
  AgentReportPayload,
  AgentSessionLaunchPayload,
  AgentStatus,
  CatalogAgent,
  WorkspaceSnapshot,
} from "@pragma/constants";

export type {
  AgentAnswer,
  AgentAttentionKind,
  AgentCatalog,
  AgentDecision,
  AgentIcon,
  AgentInput,
  AgentInterrupt,
  AgentMessage,
  AgentModelEntry,
  QuestionOption,
  AgentReasoning,
  AgentReportPayload,
  AgentSessionLaunchPayload,
  AgentStatus,
  CatalogAgent,
  WorkspaceSnapshot,
};

/** Result of `client.agents.launch(...)`: the resolved worktree + tab. */
export interface AgentSessionLaunchResult {
  worktreeId: string;
  tabId: string;
}

export interface AgentEvent {
  type: "agent";
  worktreeId: string;
  tabId: string;
  agent: string;
  status: AgentStatus;
  attentionKind: AgentAttentionKind | null;
  /** The command awaiting approval when `attentionKind` is `command`. */
  command?: string | null;
  /** The question awaiting an answer when `attentionKind` is `question`. */
  question?: string | null;
  /** Answer choices for a `question` attention, when present. */
  options?: QuestionOption[] | null;
  /** Correlation id for the command/question round-trip, when present. */
  requestId?: string | null;
}

export interface AgentMessageEvent {
  type: "agentMessage";
  message: AgentMessage;
}

/** Approve/deny verdict fanned out to agent subscribers. */
export interface AgentDecisionEvent {
  type: "agentDecision";
  decision: AgentDecision;
}

/** Question reply fanned out to agent subscribers. */
export interface AgentAnswerEvent {
  type: "agentAnswer";
  answer: AgentAnswer;
}

/** Free-form interjection fanned out to agent subscribers. */
export interface AgentInputEvent {
  type: "agentInput";
  input: AgentInput;
}

/** Transient interrupt fanned out to agent subscribers. */
export interface AgentInterruptEvent {
  type: "agentInterrupt";
  interrupt: AgentInterrupt;
}

export type AgentStreamEvent =
  | AgentEvent
  | AgentMessageEvent
  | AgentDecisionEvent
  | AgentAnswerEvent
  | AgentInputEvent
  | AgentInterruptEvent;

export interface ReportOptions {
  agent: string;
  worktreeId?: string;
  kind?: AgentAttentionKind;
  /** Command text for a `command` attention report (shown in the approval toast). */
  command?: string;
  /** Question text for a `question` attention report (shown in the answer UI). */
  question?: string;
  /** Answer choices for a `question` attention report. */
  options?: QuestionOption[];
  /** Correlation id so a waiting caller can match the resulting decision. */
  requestId?: string;
  client?: import("../client").PragmaClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export type ReportMessageOptions = Omit<ReportOptions, "kind"> & {
  message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId"> &
    Partial<Pick<AgentMessage, "agent" | "worktreeId" | "tabId">>;
};

/** Identifies the single running agent a {@link AgentConnection} is bound to. */
export interface ConnectOptions {
  /** Stable agent id of the running agent to connect to. */
  agent: string;
  /** The terminal tab hosting the agent. */
  tabId: string;
  /** The worktree hosting the agent. */
  worktreeId: string;
  /** Optional initial request sent as the first interjection on connect. */
  prompt?: string;
  /** Aborts the whole connection (read stream + in-flight sends). */
  signal?: AbortSignal;
}

/**
 * A single duplex channel to one running agent. Async-iterate it to read every
 * event routed to that agent + tab ({@link AgentStreamEvent} filtered to the
 * connect target); call the methods to talk back on the same channel —
 * {@link send} to interject, {@link answer} to reply to a question,
 * {@link decide} to approve/deny a command.
 */
export interface AgentConnection extends AsyncIterable<AgentStreamEvent> {
  /** Interjects free-form text into the agent's turn. */
  send(text: string, options?: { requestId?: string }): Promise<void>;
  /** Replies to a `question` attention request; `null` dismisses it. */
  answer(requestId: string, reply: string | null): Promise<void>;
  /** Approves (`true`) or denies (`false`) a `command` attention request. */
  decide(requestId: string, approved: boolean): Promise<void>;
  /** Interrupts the agent's current turn; a watcher sends ESC to its tab. */
  interrupt(requestId?: string): Promise<void>;
  /** Closes the read stream and releases the connection. */
  close(): void;
}
