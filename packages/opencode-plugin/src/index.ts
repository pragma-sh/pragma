import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import {
  hasPragmaEnvironment,
  reportAttention,
  reportCleared,
  reportMessage,
  reportStarted,
  reportStopped,
  type AgentAttentionKind,
  type AgentMessage,
} from "@pragma/sdk";

import { type Environment, type PragmaReporter, createPragmaOpencodeHooks } from "./hooks";

const DEFAULT_AGENT_ID = "opencode";

/** Options accepted by `@pragma/opencode-plugin` in opencode's plugin config tuple. */
export interface PragmaOpencodePluginOptions extends PluginOptions {
  /** Stable Pragma agent id. Defaults to `opencode`. */
  agent?: string;
  /** Extra environment values passed to the Pragma SDK helpers. */
  env?: Record<string, string | undefined>;
  /** Suppress debug logging even when `PRAGMA_OPENCODE_PLUGIN_DEBUG` is set. */
  quiet?: boolean;
}

/** Pragma opencode plugin — reports agent status to Pragma. */
export const PragmaOpencodePlugin: Plugin = async (
  _input: PluginInput,
  options?: PluginOptions,
) => {
  const reporter = createSdkReporter(parseOptions(options));
  // Opening opencode must not inherit a stale indicator from a previous run in
  // this same Pragma tab that exited without cleanup — e.g. killed with SIGINT
  // or crashed, where the `dispose` hook never runs to report `cleared`, so its
  // last `running`/`done`/`attention` status lingers in the long-lived daemon.
  // Clear it up front on load; genuine activity re-raises status via the hooks.
  void reporter.cleared();
  return createPragmaOpencodeHooks(reporter);
};

export default PragmaOpencodePlugin;

function parseOptions(options: PluginOptions | undefined): PragmaOpencodePluginOptions {
  return options ?? {};
}

function createSdkReporter(options: PragmaOpencodePluginOptions): PragmaReporter {
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
    message: (message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">) =>
      report(() => reportMessage({ agent, env, message })),
    cleared: () => report(() => reportCleared({ agent, env })),
  };

  async function report(run: () => Promise<unknown>): Promise<void> {
    if (!hasPragmaEnvironment(env)) {
      return;
    }
    try {
      await run();
    } catch (error) {
      if (debug) {
        console.warn("@pragma/opencode-plugin failed to report status", error);
      }
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
