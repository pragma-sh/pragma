import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  hasPragmaEnvironment,
  reportCleared,
  reportMessage,
  reportSessionName,
  reportStarted,
  reportStopped,
  type AgentMessage,
} from "@pragma/sdk";

import { PiLifecycleReporter, type PiReporter } from "./reporter";

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

    pi.on("before_agent_start", (event) => {
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
    pi.on("agent_end", (event) => reporter.end(event));
    pi.on("session_shutdown", () => reporter.clear());
  };
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
