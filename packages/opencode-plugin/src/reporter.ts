import {
  hasPragmaEnvironment,
  reportAttention,
  reportCleared,
  reportMessage,
  reportSessionId,
  reportSessionName,
  reportStarted,
  reportStopped,
  type AgentAttentionKind,
  type AgentMessage,
  type AgentQuestion,
  type QuestionOption,
} from "@pragma-sh/sdk";

import type { Environment, PragmaReporter } from "./hooks";

const DEFAULT_AGENT_ID = "opencode";

/** Options shared by the OpenCode v1 and v2 entries (plugin config `options`). */
export interface PragmaReporterOptions {
  /** Stable Pragma agent id. Defaults to `opencode`. */
  agent?: string;
  /** Extra environment values passed to the Pragma SDK helpers. */
  env?: Record<string, string | undefined>;
  /** Suppress debug logging even when `PRAGMA_OPENCODE_PLUGIN_DEBUG` is set. */
  quiet?: boolean;
}

/** Builds the reporter that turns state-machine transitions into Pragma SDK reports. */
export function createSdkReporter(options: PragmaReporterOptions): PragmaReporter {
  const agent = nonEmpty(options.agent) ?? DEFAULT_AGENT_ID;
  const env: Environment = { ...process.env, ...options.env };
  const debug = options.quiet === true ? false : env.PRAGMA_OPENCODE_PLUGIN_DEBUG === "1";

  // The hooks state machine already deduplicates and orders status changes; this
  // reporter only guards on the Pragma gateway environment and sends HTTP reports.
  return {
    env,
    started: () => report(() => reportStarted({ agent, env })),
    stopped: () => report(() => reportStopped({ agent, env })),
    attention: (kind: AgentAttentionKind) => report(() => reportAttention({ agent, env, kind })),
    attentionCommand: (command: string, requestId: string) =>
      report(() => reportAttention({ agent, env, kind: "command", command, requestId })),
    attentionQuestion: (question: string, questionOptions: QuestionOption[], requestId: string) =>
      report(() =>
        reportAttention({
          agent,
          env,
          kind: "question",
          question,
          ...(questionOptions.length > 0 ? { options: questionOptions } : {}),
          requestId,
        }),
      ),
    attentionQuestions: (questions: AgentQuestion[], requestId: string) =>
      report(() =>
        reportAttention({
          agent,
          env,
          kind: "question",
          ...(questions.length > 0 ? { questions } : {}),
          requestId,
        }),
      ),
    message: (message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">) =>
      report(() => reportMessage({ agent, env, message })),
    cleared: () => report(() => reportCleared({ agent, env })),
    sessionName: (name: string) => report(() => reportSessionName({ agent, env, name })),
    sessionId: (id: string | null) => report(() => reportSessionId({ agent, env, id })),
  };

  async function report(run: () => Promise<unknown>): Promise<void> {
    if (!hasPragmaEnvironment(env)) {
      return;
    }
    try {
      await run();
    } catch (error) {
      if (debug) {
        console.warn("@pragma-sh/opencode-plugin failed to report status", error);
      }
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
