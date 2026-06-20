import type { Hooks } from "@opencode-ai/plugin";
import { type AttentionKind } from "@pragma/sdk";

type ReportKey = "started" | "stopped" | "cleared" | `attention:${AttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

/** What a runtime event asks the reporter to do: re-derive status, reset, or nothing. */
type EventAction = "sync" | "clear" | "none";

export const PRAGMA_ENV_KEYS = [
  "PRAGMA_DAEMON_SOCKET",
  "PRAGMA_TAB_ID",
  "PRAGMA_WORKTREE_ID",
] as const;

export interface PragmaReporter {
  readonly env: Environment;
  started(): Promise<void>;
  stopped(): Promise<void>;
  attention(kind: AttentionKind): Promise<void>;
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
  let attentionKind: AttentionKind = "command";
  let lastReported: ReportKey | null = null;

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

  function raiseAttention(kind: AttentionKind): void {
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
    switch (event.type) {
      case "session.status":
        applySessionStatus(event);
        return "sync";
      case "session.idle":
        busy = false;
        return "sync";
      case "session.error":
        // An aborted turn (esc-esc / `session.abort`) surfaces as a session
        // error carrying `MessageAbortedError`. There is no result to look at,
        // so reset the indicator instead of leaving a green "finished" dot.
        if (isAbortError(event)) {
          return "clear";
        }
        busy = false;
        attention = false;
        return "sync";
      case "session.deleted":
        busy = false;
        attention = false;
        return "sync";
      case "server.instance.disposed":
        // opencode's server is shutting down (the agent is quitting): clear the
        // indicator rather than leaving a stale dot, even when the `dispose`
        // plugin hook doesn't run (e.g. an abrupt shutdown).
        return "clear";
      case "permission.asked":
      case "permission.updated":
        raiseAttention("command");
        return "sync";
      case "permission.replied":
        attention = false;
        busy = true;
        return "sync";
      case "message.part.updated":
        return applyMessagePart(event) ? "sync" : "none";
      default:
        return "none";
    }
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
    const properties = event.properties;
    const part = isRecord(properties) && "part" in properties ? properties.part : undefined;
    if (!isRecord(part) || part.type !== "tool" || part.tool !== "question") {
      return false;
    }
    const state = isRecord(part.state) ? part.state : undefined;
    if (state?.status === "completed" || state?.status === "error") {
      attention = false;
      busy = true;
    } else {
      raiseAttention("question");
    }
    return true;
  }
}

// Re-exported for index.ts to use in createSdkReporter.
export type { ReportKey, Environment };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
