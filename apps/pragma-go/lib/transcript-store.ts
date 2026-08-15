import type { AgentFileChange, AgentMessage } from "@pragma/constants";
import type { AgentStreamEvent } from "@pragma/sdk";

import {
  normalizeQuestionOptions,
  normalizeQuestions,
  type AttentionRequest,
  type TranscriptRow,
} from "./types";

const OPTIMISTIC_MESSAGE_MATCH_WINDOW_MS = 60_000;

// Pure, RN-free transcript model. The chat hook feeds it every AgentStreamEvent
// routed to the connected agent+tab; the screen renders `transcriptRows()` and
// `state.attention`. Kept side-effect-free so the upsert/ordering logic is unit
// tested without a device (see transcript-store.test.ts).

/** Accumulated chat state derived from the agent event stream. */
export interface TranscriptState {
  /** Rich messages keyed by id — later events for the same id REPLACE the entry. */
  messages: Map<string, AgentMessage>;
  /** The live command/question the agent is blocked on, or null. */
  attention: AttentionRequest | null;
}

/** A fresh, empty transcript. */
export function emptyTranscript(): TranscriptState {
  return { messages: new Map(), attention: null };
}

/**
 * Folds one stream event into the transcript, returning a NEW state object so
 * React sees a reference change. Message events upsert by id; agent status
 * events raise/clear attention; decision/answer echoes clear a matching request.
 */
export function applyEvent(state: TranscriptState, event: AgentStreamEvent): TranscriptState {
  switch (event.type) {
    case "agentMessage":
      return upsertMessage(state, event.message);
    case "agent":
      return applyAgentStatus(state, event);
    case "agentDecision":
      return clearIfMatches(state, event.decision.requestId);
    case "agentAnswer":
      return clearIfMatches(state, event.answer.requestId);
    case "agentInput":
    case "agentInterrupt":
      return state;
  }
}

/**
 * Optimistically appends a locally-sent user message so the composer feels
 * responsive before the agent echoes anything back.
 */
export function applyLocalInput(state: TranscriptState, text: string, ts: number): TranscriptState {
  const id = `local-input-${ts}`;
  const message: AgentMessage = {
    agent: "",
    worktreeId: "",
    tabId: "",
    id,
    role: "user",
    text,
    subAgentsActive: 0,
    ts,
  };
  return upsertMessage(state, message);
}

/**
 * AgentMessage.ts is defined as milliseconds since Unix epoch. Some reporters
 * (Claude Code / Cursor shell hooks) historically stamped `date +%s` seconds;
 * those values sort ~1e6× earlier than Date.now()-stamped local input and push
 * every agent bubble off the top of the inverted chat list. Values below 1e12
 * cannot be legitimate ms timestamps until year 33658 — treat them as seconds.
 */
function normalizeMessageTs(ts: number): number {
  return ts > 0 && ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

function upsertMessage(state: TranscriptState, message: AgentMessage): TranscriptState {
  const existing = state.messages.get(message.id);
  const normalized =
    message.ts === normalizeMessageTs(message.ts)
      ? message
      : { ...message, ts: normalizeMessageTs(message.ts) };
  const messages = new Map(state.messages);
  if (normalized.role === "user" && !normalized.id.startsWith("local-input-")) {
    const optimistic = [...messages.values()].find(
      (candidate) =>
        candidate.id.startsWith("local-input-") &&
        candidate.text?.trim() === normalized.text?.trim() &&
        Math.abs(candidate.ts - normalized.ts) <= OPTIMISTIC_MESSAGE_MATCH_WINDOW_MS,
    );
    if (optimistic) messages.delete(optimistic.id);
  }
  messages.set(normalized.id, existing ? { ...normalized, ts: existing.ts } : normalized);
  return { ...state, messages };
}

function applyAgentStatus(
  state: TranscriptState,
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): TranscriptState {
  const attention = attentionForEvent(event);
  if (attention) return { ...state, attention };
  // Any non-attention status means the agent moved on — drop a stale request.
  return state.attention ? { ...state, attention: null } : state;
}

function attentionForEvent(
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): AttentionRequest | null {
  if (!isAttentionEvent(event)) return null;
  return attentionRequest(event);
}

function isAttentionEvent(event: Extract<AgentStreamEvent, { type: "agent" }>): event is Extract<
  AgentStreamEvent,
  { type: "agent" }
> & {
  attentionKind: NonNullable<Extract<AgentStreamEvent, { type: "agent" }>["attentionKind"]>;
  requestId: string;
} {
  return event.status === "attention" && Boolean(event.attentionKind) && Boolean(event.requestId);
}

function attentionRequest(
  event: Extract<AgentStreamEvent, { type: "agent" }> & {
    attentionKind: NonNullable<Extract<AgentStreamEvent, { type: "agent" }>["attentionKind"]>;
    requestId: string;
  },
): AttentionRequest {
  const preferredPrompt = event.attentionKind === "command" ? event.command : event.question;
  const options = normalizeQuestionOptions(event.options);
  const questions = normalizeQuestions(event.questions);
  const attention: AttentionRequest = {
    kind: event.attentionKind,
    requestId: event.requestId,
    prompt: preferredPrompt ?? event.command ?? event.question ?? "",
  };
  if (options) attention.options = options;
  if (questions) attention.questions = questions;
  return attention;
}

function clearIfMatches(state: TranscriptState, requestId: string): TranscriptState {
  if (state.attention?.requestId === requestId) {
    return { ...state, attention: null };
  }
  return state;
}

/** Ordered, flattened rows for the message list (oldest first). */
export function transcriptRows(state: TranscriptState): TranscriptRow[] {
  // Hermes does not yet provide Array.prototype.toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  const ordered = [...state.messages.values()].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ordered.flatMap(rowsForMessage);
}

/** Expands one message into its prose row (if any) plus gray event lines. */
function rowsForMessage(message: AgentMessage): TranscriptRow[] {
  if (message.id.startsWith("reasoning:")) return [];
  const rows: TranscriptRow[] = [];
  const text = message.text?.trim();
  if (text) {
    rows.push({ kind: "message", id: message.id, role: message.role, text, ts: message.ts });
  }
  for (const call of message.toolCalls ?? []) {
    const summary = call.summary?.trim();
    rows.push({
      kind: "event",
      id: `${message.id}:tool:${call.id}`,
      text: formatToolLine(call.name, call.status, summary),
      ts: message.ts,
      tool: {
        name: call.name,
        status: call.status,
        ...(summary ? { summary } : {}),
      },
    });
  }
  (message.files ?? []).forEach((file, index) => {
    rows.push({
      kind: "event",
      id: `${message.id}:file:${index}`,
      text: `${fileVerb(file.change)} ${file.path}`,
      ts: message.ts,
    });
  });
  if (message.subAgentsActive > 0) {
    rows.push({
      kind: "event",
      id: `${message.id}:subagents`,
      text: `spawned ${message.subAgentsActive} sub-agent${message.subAgentsActive === 1 ? "" : "s"}`,
      ts: message.ts,
    });
  }
  return rows;
}

/** Past-tense verb for a file change, e.g. "edited". */
function fileVerb(change: AgentFileChange["change"]): string {
  switch (change) {
    case "read":
      return "read";
    case "edited":
      return "edited";
    case "created":
      return "created";
    case "deleted":
      return "deleted";
  }
}

/** Compact activity line for a tool call, e.g. "bash · running — npm test". */
function formatToolLine(name: string, status: string, summary: string | undefined): string {
  const statusLabel = status === "done" ? "done" : status === "error" ? "error" : "running";
  return summary ? `${name} · ${statusLabel} — ${summary}` : `${name} · ${statusLabel}`;
}
