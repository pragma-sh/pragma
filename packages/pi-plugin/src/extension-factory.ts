import { existsSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  hasPragmaEnvironment,
  reportCleared,
  reportMessage,
  reportSessionId,
  reportSessionName,
  reportStarted,
  reportStopped,
  type AgentMessage,
} from "@pragma-sh/sdk";

import { PiLifecycleReporter, type PiReporter, type PiSessionObservation } from "./reporter";

/** Identity and diagnostics for one Pi-derived agent extension. */
export interface PiExtensionOptions {
  agentId: string;
  debugEnvVar: string;
  logLabel: string;
}

/** Creates a Pi-compatible extension that reports lifecycle and transcript events to Pragma. */
export function createPiExtension(options: PiExtensionOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    const env = process.env;
    const reporter = new PiLifecycleReporter(createSdkReporter(options, env));
    void reporter.clear();

    // Every session start is an identity transition — startup, resume, fork,
    // new, or an in-TUI switch — so observe the top-level session even when it
    // shares the previous one's title and no prompt follows. Pi's own name
    // (a rename or a resumed named session) wins over the prompt fallback.
    pi.on("session_start", (_event, ctx) => {
      void reporter.identifySession(observeSession(ctx));
      return reporter.nameSession(ctx.sessionManager.getSessionName());
    });
    pi.on("session_info_changed", (event) => reporter.nameSession(event.name));
    pi.on("before_agent_start", (event, ctx) => {
      // Re-assert the top-level identity before activity. The reporter keeps
      // only the last observed session, so a switch reports again while
      // repeated turns of one session do not.
      void reporter.identifySession(observeSession(ctx));
      void reporter.nameSessionFromPrompt(event.prompt);
      return reporter.sendMessage({
        id: `user:${event.prompt.slice(0, 48)}:${Date.now()}`,
        role: "user",
        text: event.prompt,
        subAgentsActive: 0,
        ts: Date.now(),
      });
    });
    pi.on("agent_start", () => reporter.start());
    pi.on("message_update", (event) => {
      if (event.message.role !== "assistant") return;
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (!text) return;
      return reporter.sendMessage({
        id: `assistant:${event.message.timestamp}`,
        role: "assistant",
        text,
        subAgentsActive: 0,
        ts: event.message.timestamp,
      });
    });
    pi.on("agent_end", (event, ctx) => {
      // Pi writes the session file once its first assistant message exists, so
      // a brand-new session has no resumable locator until this point.
      // Reporting it here keeps a crash after the first turn restorable.
      void reporter.identifySession(observeSession(ctx));
      return reporter.end(event);
    });
    pi.on("session_shutdown", () => reporter.clear());
  };
}

/**
 * One observation of the extension's own top-level session: the session
 * manager's id (always present) and the resumable locator once Pi has written
 * the session file. Pi reserves the file path up front but only writes the
 * file after the first assistant message, so a new session has no locator for
 * its first turn.
 */
function observeSession(ctx: ExtensionContext): PiSessionObservation {
  const id = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  return { id, locator: file && existsSync(file) ? id : null };
}

function createSdkReporter(options: PiExtensionOptions, env: NodeJS.ProcessEnv): PiReporter {
  const { agentId } = options;
  return {
    started: () => bestEffort(() => reportStarted({ agent: agentId, env }), options, env),
    stopped: () => bestEffort(() => reportStopped({ agent: agentId, env }), options, env),
    cleared: () => bestEffort(() => reportCleared({ agent: agentId, env }), options, env),
    message: (message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">) =>
      bestEffort(() => reportMessage({ agent: agentId, env, message }), options, env),
    sessionName: (name: string) =>
      bestEffort(() => reportSessionName({ agent: agentId, env, name }), options, env),
    sessionId: (id: string | null) =>
      bestEffort(() => reportSessionId({ agent: agentId, env, id }), options, env),
  };
}

async function bestEffort(
  run: () => Promise<unknown>,
  options: PiExtensionOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!hasPragmaEnvironment(env)) return;
  try {
    await run();
  } catch (error) {
    if (env[options.debugEnvVar] === "1") {
      console.warn(`${options.logLabel} failed to report to Pragma`, error);
    }
  }
}
