/**
 * The slice of Oh My Pi's extension API this integration uses, declared
 * structurally. `@oh-my-pi/pi-coding-agent` ships TypeScript source that needs
 * Bun >= 1.4 and its own workspace to typecheck, so it is not a dev
 * dependency; these shapes mirror omp 18.18's
 * `src/extensibility/extensions/types.ts`.
 */

/** Which agent a handler is serving. Factories are rebound to every subagent session. */
export interface OmpAgentIdentity {
  /** `"main"` for the top-level session, `"sub"` for any spawned one (task, eval, `/tan`). */
  kind: "main" | "sub";
  /** Agent registry id, e.g. `"Main"` or `"0-Explore"`. */
  id: string;
  /** Registry id of the agent that spawned this one. */
  parentId?: string;
}

/** Read-only session manager accessors. */
export interface OmpSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
}

/** The handler context omp passes with every event. */
export interface OmpExtensionContext {
  agent: OmpAgentIdentity;
  sessionManager: OmpSessionManager;
}

/** A content part of an assistant message. */
export interface OmpContentPart {
  type: string;
  text?: string;
}

/** An agent message as carried on lifecycle events. */
export interface OmpAgentMessage {
  role: string;
  content?: string | OmpContentPart[];
  stopReason?: string;
  timestamp?: number;
}

/** Fired before an ordinary prompt reaches the provider, or once when a parked subagent revives. */
export interface OmpBeforeAgentStartEvent {
  reason: "prompt" | "revive";
  prompt: string;
}

/** Fired when an agent loop ends. */
export interface OmpAgentEndEvent {
  messages: OmpAgentMessage[];
  /** Not a terminal settle: an automatic continuation or background work may resume. */
  willContinue?: boolean;
}

/** Fired during assistant streaming. */
export interface OmpMessageUpdateEvent {
  message: OmpAgentMessage;
}

/** Fired after an in-TUI switch to another session. */
export interface OmpSessionSwitchEvent {
  reason: "new" | "resume" | "fork";
}

/** Fired when a tool starts executing (after any approval). */
export interface OmpToolExecutionStartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Fired when a tool finishes, including a cancelled `ask`. */
export interface OmpToolExecutionEndEvent {
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

type Handler<E> = (event: E, ctx: OmpExtensionContext) => unknown;

/** The `pi` object an omp extension factory receives. */
export interface OmpExtensionAPI {
  on(event: "session_start", handler: Handler<unknown>): void;
  on(event: "session_switch", handler: Handler<OmpSessionSwitchEvent>): void;
  on(event: "session_branch", handler: Handler<unknown>): void;
  on(event: "session_shutdown", handler: Handler<unknown>): void;
  on(event: "before_agent_start", handler: Handler<OmpBeforeAgentStartEvent>): void;
  on(event: "agent_start", handler: Handler<unknown>): void;
  on(event: "agent_end", handler: Handler<OmpAgentEndEvent>): void;
  on(event: "message_update", handler: Handler<OmpMessageUpdateEvent>): void;
  on(event: "tool_execution_start", handler: Handler<OmpToolExecutionStartEvent>): void;
  on(event: "tool_execution_end", handler: Handler<OmpToolExecutionEndEvent>): void;
}
