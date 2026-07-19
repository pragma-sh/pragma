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

const AGENT_ID = "pi";

/** Pi extension that reports lifecycle and streaming transcript updates to Pragma. */
export default function pragmaPiExtension(pi: ExtensionAPI): void {
  const env = process.env;
  const reporter = new PiLifecycleReporter(createSdkReporter(env));
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
}

function createSdkReporter(env: NodeJS.ProcessEnv): PiReporter {
  return {
    started: () => bestEffort(() => reportStarted({ agent: AGENT_ID, env }), env),
    stopped: () => bestEffort(() => reportStopped({ agent: AGENT_ID, env }), env),
    cleared: () => bestEffort(() => reportCleared({ agent: AGENT_ID, env }), env),
    message: (message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">) =>
      bestEffort(() => reportMessage({ agent: AGENT_ID, env, message }), env),
    sessionName: (name: string) =>
      bestEffort(() => reportSessionName({ agent: AGENT_ID, env, name }), env),
  };
}

async function bestEffort(run: () => Promise<unknown>, env: NodeJS.ProcessEnv): Promise<void> {
  if (!hasPragmaEnvironment(env)) return;
  try {
    await run();
  } catch (error) {
    if (env.PRAGMA_PI_PLUGIN_DEBUG === "1") {
      console.warn("@pragma/pi-plugin failed to report to Pragma", error);
    }
  }
}
