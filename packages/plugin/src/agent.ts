import type { AgentFeature as SharedAgentFeature } from "@pragma/constants";

import type { PluginIcon } from "./contributions";
import type { PluginContext } from "./types";

/**
 * Timed input sent to the agent's terminal after launch and before an
 * optional prompt prefill. Field names mirror the host's existing
 * the old `~/.pragma/agents/<id>/config.json` shape (`startupInput`) exactly, so
 * plugin-contributed agents carry over unchanged.
 */
export interface AgentStartupInput {
  delayMs: number;
  data: string;
}

/** One selectable reasoning-effort level for a model. */
export interface AgentReasoning {
  id: string;
  name: string;
}

/** One selectable model for an agent. */
export interface AgentModelEntry {
  id: string;
  name: string;
  reasoning?: AgentReasoning[];
}

/** One selectable permission mode for an agent. */
export interface AgentPermissionMode {
  id: string;
  name: string;
}

/** Builds the launch command-line arguments for a selected model/reasoning/permission mode. */
export interface AgentArgsBuilder {
  model: (modelId: string) => string[];
  reasoning: (reasoningId: string) => string[];
  modelReasoning?: (modelId: string, reasoningId: string) => string[];
  permissionMode: (permissionModeId: string) => string[];
}

/** Optional agent capabilities that can be excluded from `pragma-cli agent verify`. */
export type AgentFeature = SharedAgentFeature;

/**
 * Declares an agent a plugin makes launchable from Pragma. Field names below
 * `launch`/`models`/`permissionModes`/`args` are new, JS-only additions;
 * `startupInput`/`prefillDelayMs`/`prefillMode`/`prefillSubmit`/
 * `prefillSubmitDelayMs` carry over the existing agent-launcher config shape
 * exactly (see `src-tauri/src/agents.rs`).
 */
export interface AgentDefinition<TConfig = unknown> {
  id: string;
  name: string;
  icon: PluginIcon;
  /** Browser URL, absolute filesystem path, or plugin-dir-relative asset path for the agent icon. */
  iconPath?: string;
  launch: { command: string[] };
  models: AgentModelEntry[] | ((ctx: PluginContext<TConfig>) => Promise<AgentModelEntry[]>);
  permissionModes: AgentPermissionMode[];
  args: AgentArgsBuilder;
  /** Capabilities this agent does not support; matching verification scenarios are skipped. */
  excludeFeatures?: AgentFeature[];
  startupInput?: AgentStartupInput[];
  prefillDelayMs?: number;
  prefillMode?: "bracketed" | "plain";
  prefillSubmit?: string;
  prefillSubmitDelayMs?: number;
}

/** Declares an agent contribution. */
export function defineAgent<TConfig = unknown>(
  input: AgentDefinition<TConfig>,
): AgentDefinition<TConfig> {
  return input;
}
