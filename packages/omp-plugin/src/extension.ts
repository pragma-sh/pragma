import { existsSync } from "node:fs";

import {
  PiLifecycleReporter,
  type PiReporter,
  type PiSessionObservation,
} from "@pragma-sh/pi-plugin/reporter";

import type { AgentQuestion } from "@pragma-sh/sdk";

import { askQuestions, loadOmpFormModules, type OmpFormModules } from "./ask-form";
import type {
  OmpAgentEndEvent,
  OmpAgentMessage,
  OmpExtensionAPI,
  OmpExtensionContext,
} from "./omp-api";
import { sharedSubagentTracker, type SubagentTracker } from "./subagents";

/** Dependencies of one omp extension binding. */
export interface OmpExtensionOptions {
  /** Best-effort reporting surface (SDK-backed in production). */
  reporter: PiReporter;
  /** Subagent registry shared across bindings; defaults to the process-wide one. */
  tracker?: SubagentTracker;
  /** Whether a session file exists on disk; injectable for tests. */
  fileExists?: (path: string) => boolean;
  /**
   * Reports one `ask` form as question attention, keyed by the tool call id so
   * the watcher can match the answer to the dialog it drives.
   */
  askAttention: (questions: AgentQuestion[], requestId: string) => Promise<void>;
  /** omp's form parser; defaults to the copy bundled in the running omp. */
  formModules?: () => Promise<OmpFormModules>;
}

/** omp's question tool: one HTML form rendered as a native TUI dialog. */
const ASK_TOOL = "ask";

/**
 * Creates an omp extension factory that reports lifecycle, transcript, session
 * identity, and subagent activity to Pragma.
 *
 * omp binds the factory once for the main session and again for every
 * subagent session in the same process, so each handler first asks
 * `ctx.agent.kind`. Only the main session reports status, messages, and
 * identity; a subagent binding only feeds the shared {@link SubagentTracker},
 * which the main binding turns into `subAgentsActive` activity and uses to
 * hold `stopped` until every subagent has settled.
 */
export function createOmpExtension(options: OmpExtensionOptions): (pi: OmpExtensionAPI) => void {
  const tracker = options.tracker ?? sharedSubagentTracker;
  const fileExists = options.fileExists ?? existsSync;
  const formModules = options.formModules ?? loadOmpFormModules;

  return (pi) => {
    const reporter = new PiLifecycleReporter(options.reporter);
    let mainSessionId: string | undefined;
    let nativeName: string | undefined;
    /** A normal main-turn end held back while subagents were still running. */
    let pendingStop = false;
    let unsubscribe: (() => void) | undefined;

    const observe = (ctx: OmpExtensionContext): PiSessionObservation => {
      const id = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile();
      return { id, locator: file && fileExists(file) ? id : null };
    };

    // omp generates a session title asynchronously after the first prompt and
    // exposes no rename event, so poll its name on every main event. A native
    // title wins over the first-prompt fallback.
    const syncName = (ctx: OmpExtensionContext): void => {
      const name = ctx.sessionManager.getSessionName()?.trim() || undefined;
      if (name === nativeName) return;
      nativeName = name;
      if (name) void reporter.nameSession(name);
    };

    const reportSubagents = (active: number): void => {
      void reporter.sendMessage({
        id: `subagents:${mainSessionId ?? "main"}`,
        role: "system",
        subAgentsActive: active,
        ts: Date.now(),
      });
      if (active === 0 && pendingStop) {
        pendingStop = false;
        void reporter.end({ messages: [] });
      }
    };

    const resetSession = (ctx: OmpExtensionContext): void => {
      mainSessionId = ctx.sessionManager.getSessionId();
      pendingStop = false;
      nativeName = undefined;
      void reporter.clear();
      void reporter.identifySession(observe(ctx));
      syncName(ctx);
    };

    pi.on("session_start", (_event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      unsubscribe ??= tracker.subscribe(reportSubagents);
      resetSession(ctx);
    });
    // `/new`, `/resume`, `/fork`, and tree branches change the conversation
    // running in this tab without a fresh `session_start`.
    pi.on("session_switch", (_event, ctx) => {
      if (ctx.agent.kind === "main") resetSession(ctx);
    });
    pi.on("session_branch", (_event, ctx) => {
      if (ctx.agent.kind === "main") resetSession(ctx);
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.reason !== "prompt") return;
      void reporter.identifySession(observe(ctx));
      syncName(ctx);
      void reporter.nameSessionFromPrompt(event.prompt);
      return reporter.sendMessage({
        id: `user:${event.prompt.slice(0, 48)}:${Date.now()}`,
        role: "user",
        text: event.prompt,
        subAgentsActive: tracker.active,
        ts: Date.now(),
      });
    });

    pi.on("agent_start", (_event, ctx) => {
      if (ctx.agent.kind === "sub") {
        tracker.start(ctx.agent.id);
        return;
      }
      pendingStop = false;
      return reporter.start();
    });

    pi.on("message_update", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.message.role !== "assistant") return;
      const text = assistantText(event.message);
      if (!text) return;
      const ts = event.message.timestamp ?? Date.now();
      return reporter.sendMessage({
        id: `assistant:${ts}`,
        role: "assistant",
        text,
        subAgentsActive: tracker.active,
        ts,
      });
    });

    // `ask` opens its dialog when the tool executes; report it as a question
    // so Pragma can answer it, and return to running once the tool settles
    // (answered, cancelled, or timed out). A form that cannot be parsed still
    // raises attention, just without structured questions.
    pi.on("tool_execution_start", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.toolName !== ASK_TOOL) return;
      const html = (event.args as { html?: unknown } | undefined)?.html;
      void reporter.attention(async () => {
        let questions: AgentQuestion[] = [];
        if (typeof html === "string") {
          try {
            questions = askQuestions(html, await formModules());
          } catch {
            // Unparseable or unavailable: report bare attention below.
          }
        }
        await options.askAttention(questions, event.toolCallId);
      });
    });
    pi.on("tool_execution_end", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.toolName !== ASK_TOOL) return;
      void reporter.resume();
    });

    pi.on("agent_end", (event, ctx) => {
      if (ctx.agent.kind === "sub") {
        if (!event.willContinue) tracker.end(ctx.agent.id);
        return;
      }
      // omp writes the session file lazily, on the first completed turn, so a
      // brand-new session only becomes resumable here.
      void reporter.identifySession(observe(ctx));
      syncName(ctx);
      // A scheduled continuation or background wake keeps the turn running.
      if (event.willContinue) return;
      if (!isAborted(event) && tracker.active > 0) {
        pendingStop = true;
        return;
      }
      pendingStop = false;
      return reporter.end(event);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.agent.kind === "sub") {
        tracker.end(ctx.agent.id);
        return;
      }
      pendingStop = false;
      unsubscribe?.();
      unsubscribe = undefined;
      return reporter.clear();
    });
  };
}

function assistantText(message: OmpAgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function isAborted(event: OmpAgentEndEvent): boolean {
  return event.messages.some(
    (message) => message.role === "assistant" && message.stopReason === "aborted",
  );
}
