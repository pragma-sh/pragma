import type { Hooks } from "@opencode-ai/plugin";
import { type AttentionKind } from "@pragma/sdk";

type ReportKey = "started" | "stopped" | `attention:${AttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

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
      if (applyEvent(event as RuntimeEvent)) {
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
      busy = false;
      attention = false;
      await sync();
    },
  };

  function raiseAttention(kind: AttentionKind): void {
    attention = true;
    attentionKind = kind;
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
    lastReported = next;
    if (next === "started") {
      await reporter.started();
    } else if (next === "stopped") {
      await reporter.stopped();
    } else {
      await reporter.attention(attentionKind);
    }
  }

  /** Updates the flags for a runtime event; returns whether the event was handled. */
  function applyEvent(event: RuntimeEvent): boolean {
    switch (event.type) {
      case "session.status":
        applySessionStatus(event);
        return true;
      case "session.idle":
        busy = false;
        return true;
      case "session.error":
      case "session.deleted":
        busy = false;
        attention = false;
        return true;
      case "permission.updated":
        raiseAttention("command");
        return true;
      case "permission.replied":
        attention = false;
        busy = true;
        return true;
      case "message.part.updated":
        return applyMessagePart(event);
      default:
        return false;
    }
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
