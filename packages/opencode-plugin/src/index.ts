import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import {
  reportAttention,
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
  /** Path or executable name for the Pragma agent CLI. Defaults to `pragma-agent`. */
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
  return createPragmaOpencodeHooks(createSdkReporter(input, parseOptions(options)));
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
