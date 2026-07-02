import type { Hooks } from "@opencode-ai/plugin";
import { type AgentAttentionKind } from "@pragma/sdk";

type ReportKey = "started" | "stopped" | "cleared" | `attention:${AgentAttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

/** What a runtime event asks the reporter to do: re-derive status, reset, or nothing. */
type EventAction = "sync" | "clear" | "none";

const PRAGMA_ENV_KEYS = [
  "PRAGMA_GATEWAY_URL",
  "PRAGMA_GATEWAY_TOKEN",
  "PRAGMA_DAEMON_SOCKET",
  "PRAGMA_TAB_ID",
  "PRAGMA_WORKTREE_ID",
] as const;

export interface PragmaReporter {
  readonly env: Environment;
  started(): Promise<void>;
  stopped(): Promise<void>;
  attention(kind: AgentAttentionKind): Promise<void>;
  /** Removes the tab's indicator entirely (agent process exited), not a green "done". */
  cleared(): Promise<void>;
}

/**
 * Creates opencode hooks that mirror runtime activity into Pragma agent reports.
 *
 * Status is derived from two orthogonal flags rather than mapped per event, so
 * precedence is explicit and stable: **attention (red) > busy (yellow) > idle
 * (green)**. opencode streams a flurry of `message.*` events while generating
 * and emits a separate idle signal when a turn ends; deriving the reported
 * status from the flags (and only emitting on change) keeps a trailing stream
 * event from clobbering green back to yellow, and keeps red pinned while a
 * prompt is awaiting an answer even though the session reports idle meanwhile.
 */
export function createPragmaOpencodeHooks(reporter: PragmaReporter): Hooks {
  let busy = false;
  let attention = false;
  let attentionKind: AgentAttentionKind = "command";
  let lastReported: ReportKey | null = null;

  const EVENT_HANDLERS: Record<string, (event: RuntimeEvent) => EventAction> = {
    "session.status": applySessionStatusEvent,
    "session.idle": applySessionIdleEvent,
    "session.error": applySessionErrorEvent,
    "session.deleted": applySessionDeletedEvent,
    "server.instance.disposed": () => "clear",
    "permission.asked": applyPermissionAskedEvent,
    "permission.updated": applyPermissionAskedEvent,
    "permission.replied": applyPermissionRepliedEvent,
    "message.part.updated": applyMessagePartEvent,
  };

  return {
    event: async ({ event }) => {
      const action = applyEvent(event as RuntimeEvent);
      if (action === "clear") {
        await clear();
      } else if (action === "sync") {
        await sync();
      }
    },
    "chat.message": async () => {
      busy = true;
      await sync();
    },
    "command.execute.before": async () => {
      busy = true;
      await sync();
    },
    "tool.execute.before": async (input) => {
      if (input.tool === "question") {
        raiseAttention("question");
      } else {
        busy = true;
      }
      await sync();
    },
    "permission.ask": async () => {
      raiseAttention("command");
      await sync();
    },
    "shell.env": async (_input, output) => {
      for (const key of PRAGMA_ENV_KEYS) {
        const value = reporter.env[key];
        if (value) {
          output.env[key] = value;
        }
      }
    },
    dispose: async () => {
      // The agent process is exiting, not just finishing a turn: clear the
      // indicator outright rather than leaving a green "done" dot behind.
      await clear();
    },
  };

  function raiseAttention(kind: AgentAttentionKind): void {
    attention = true;
    attentionKind = kind;
  }

  /**
   * Resets all status and removes the tab's indicator entirely (the agent quit
   * or its turn was aborted — there is no result to "go look" at). Distinct from
   * `stopped`/`done`, which leaves a green dot.
   */
  async function clear(): Promise<void> {
    busy = false;
    attention = false;
    if (lastReported === "cleared") {
      return;
    }
    lastReported = "cleared";
    await reporter.cleared();
  }

  function currentReport(): ReportKey {
    if (attention) {
      return `attention:${attentionKind}`;
    }
    if (busy) {
      return "started";
    }
    return "stopped";
  }

  async function sync(): Promise<void> {
    const next = currentReport();
    if (next === lastReported) {
      return;
    }
    // `stopped` is the green "finished, go look" signal — only meaningful once
    // the agent has actually been running. Suppressing it otherwise stops a bare
    // idle, or the idle that may trail an aborted/cleared turn, from resurrecting
    // a phantom "finished" dot and notification.
    if (next === "stopped" && lastReported !== "started") {
      return;
    }
    lastReported = next;
    if (next === "started") {
      await reporter.started();
    } else if (next === "stopped") {
      await reporter.stopped();
    } else {
      await reporter.attention(attentionKind);
    }
  }

  /** Updates the flags for a runtime event and returns the action to take. */
  function applyEvent(event: RuntimeEvent): EventAction {
    const handler = EVENT_HANDLERS[event.type];
    return handler ? handler(event) : "none";
  }

  function applySessionStatusEvent(event: RuntimeEvent): EventAction {
    applySessionStatus(event);
    return "sync";
  }

  function applySessionIdleEvent(): EventAction {
    busy = false;
    return "sync";
  }

  function applySessionErrorEvent(event: RuntimeEvent): EventAction {
    // An aborted turn (esc-esc / `session.abort`) surfaces as a session
    // error carrying `MessageAbortedError`. There is no result to look at,
    // so reset the indicator instead of leaving a green "finished" dot.
    if (isAbortError(event)) {
      return "clear";
    }
    busy = false;
    attention = false;
    return "sync";
  }

  function applySessionDeletedEvent(): EventAction {
    busy = false;
    attention = false;
    return "sync";
  }

  function applyPermissionAskedEvent(): EventAction {
    raiseAttention("command");
    return "sync";
  }

  function applyPermissionRepliedEvent(): EventAction {
    attention = false;
    busy = true;
    return "sync";
  }

  function applyMessagePartEvent(event: RuntimeEvent): EventAction {
    return applyMessagePart(event) ? "sync" : "none";
  }

  /** Whether a `session.error` event carries opencode's abort error. */
  function isAbortError(event: RuntimeEvent): boolean {
    const error = (event.properties as Record<string, unknown> | undefined)?.error;
    return isRecord(error) && error.name === "MessageAbortedError";
  }

  function applySessionStatus(event: RuntimeEvent): void {
    const status = (event.properties as Record<string, unknown> | undefined)?.status;
    busy = !(isRecord(status) && status.type === "idle");
  }

  /** Handles only the question tool: raise attention while pending, resume once resolved. */
  function applyMessagePart(event: RuntimeEvent): boolean {
    const part = questionPartFromEvent(event);
    if (!part) {
      return false;
    }
    applyQuestionPartState(part);
    return true;
  }

  /** Pulls the `question` tool part out of a `message.part.updated` event, if any. */
  function questionPartFromEvent(event: RuntimeEvent): Record<string, unknown> | undefined {
    const properties = event.properties;
    const part = isRecord(properties) && "part" in properties ? properties.part : undefined;
    if (!isRecord(part) || part.type !== "tool" || part.tool !== "question") {
      return undefined;
    }
    return part;
  }

  /** Updates flags from a question tool part's state: resume when resolved, else raise. */
  function applyQuestionPartState(part: Record<string, unknown>): void {
    const state = isRecord(part.state) ? part.state : undefined;
    const status = state?.status;
    if (status === "completed" || status === "error") {
      attention = false;
      busy = true;
    } else {
      raiseAttention("question");
    }
  }
}

export type { Environment };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
