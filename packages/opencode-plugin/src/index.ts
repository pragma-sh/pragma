import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import {
  reportAttention,
  reportCleared,
  reportStarted,
  reportStopped,
  type AttentionKind,
  type PragmaAgentSpawnOptions,
} from "@pragma/sdk";

import {
  type Environment,
  type PragmaReporter,
  PRAGMA_ENV_KEYS,
  createPragmaOpencodeHooks,
} from "./hooks";

const DEFAULT_AGENT_ID = "opencode";

/** Options accepted by `@pragma/opencode-plugin` in opencode's plugin config tuple. */
export interface PragmaOpencodePluginOptions extends PluginOptions {
  /** Stable Pragma agent id. Defaults to `opencode`. */
  agent?: string;
  /** Path or executable name for the Pragma CLI. Defaults to `pragma-cli`. */
  executable?: string;
  /** Extra environment values passed to the Pragma SDK helpers. */
  env?: Record<string, string | undefined>;
  /** Working directory for the Pragma SDK helper process. */
  cwd?: string;
  /** Suppress debug logging even when `PRAGMA_OPENCODE_PLUGIN_DEBUG` is set. */
  quiet?: boolean;
}

/** Pragma opencode plugin — reports agent status to Pragma. */
export const PragmaOpencodePlugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const reporter = createSdkReporter(input, parseOptions(options));
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

function createSdkReporter(
  input: PluginInput,
  options: PragmaOpencodePluginOptions,
): PragmaReporter {
  const agent = nonEmpty(options.agent) ?? DEFAULT_AGENT_ID;
  const env: Environment = { ...process.env, ...options.env };
  const spawnOptions: PragmaAgentSpawnOptions = {
    cwd: options.cwd ?? input.directory,
    env,
    executable: options.executable,
  };
  const debug = options.quiet === true ? false : env.PRAGMA_OPENCODE_PLUGIN_DEBUG === "1";

  // The hooks state machine already deduplicates and orders status changes; this
  // reporter only guards on the Pragma environment and shells out to the CLI.
  return {
    env,
    started: () => report(() => reportStarted({ ...spawnOptions, agent })),
    stopped: () => report(() => reportStopped({ ...spawnOptions, agent })),
    attention: (kind: AttentionKind) =>
      report(() => reportAttention({ ...spawnOptions, agent, kind })),
    cleared: () => report(() => reportCleared({ ...spawnOptions, agent })),
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

function hasPragmaEnvironment(env: Environment): boolean {
  return PRAGMA_ENV_KEYS.every((key) => Boolean(env[key]));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
