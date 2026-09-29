import type { AgentFeature as SharedAgentFeature } from "@pragma-sh/constants";

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

/**
 * One selectable permission mode for an agent. The first entry of
 * {@link AgentDefinition.permissionModes} is the default: a launch that selects
 * none applies it.
 */
export interface AgentPermissionMode {
  id: string;
  name: string;
  description?: string;
}

/**
 * One primary agent/mode the host tool can start in — opencode's `build` and
 * `plan`, a Claude Code `--agent`. Cycled with Shift+Tab in the launcher. The
 * first entry of {@link AgentDefinition.modes} is the tool's default.
 */
export interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

/** One slash command the agent accepts in its prompt, offered by the launcher's `/` picker. */
export interface AgentSlashCommand {
  /** Name without the leading slash (`review`, `frontend:component`). */
  name: string;
  description?: string;
  /** Hint for the text expected after the command, e.g. `[pr-number]`. */
  argumentHint?: string;
  /**
   * Text that invokes this command when it differs from the agent-wide rule
   * (`args.slashCommand`), e.g. Codex skills are `$name`, not `/name`.
   */
  invocation?: string;
}

/** A static list, or an async provider resolved against the plugin context. */
export type AgentOptionSource<T, TConfig = unknown> =
  | T[]
  | ((ctx: PluginContext<TConfig>) => Promise<T[]>);

/** Builds the launch command-line arguments for a selected model/reasoning/mode/permission mode. */
export interface AgentArgsBuilder {
  model: (modelId: string) => string[];
  reasoning: (reasoningId: string) => string[];
  modelReasoning?: (modelId: string, reasoningId: string) => string[];
  permissionMode: (permissionModeId: string) => string[];
  /** Args that start the agent in one of {@link AgentDefinition.modes}. */
  mode?: (modeId: string) => string[];
  /**
   * Text the agent's TUI expects to invoke a slash command; the launch prompt
   * becomes `<invocation> <input>`. Defaults to {@link defaultSlashCommandInvocation}.
   */
  slashCommand?: (name: string) => string;
}

/** Optional agent capabilities that can be excluded from `pragma-cli agent verify`. */
export type AgentFeature = SharedAgentFeature;

/**
 * Declares an agent a plugin makes launchable from Pragma. Field names below
 * `launch`/`models`/`permissionModes`/`modes`/`slashCommands`/`args` are new,
 * JS-only additions;
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
  /** Permission modes; the first is the default applied when a launch selects none. */
  permissionModes: AgentOptionSource<AgentPermissionMode, TConfig>;
  /** Primary agents/modes (Shift+Tab in the launcher); the first is the default. */
  modes?: AgentOptionSource<AgentMode, TConfig>;
  /** Slash commands offered by the launcher's `/` picker. See {@link discoverSlashCommands}. */
  slashCommands?: AgentOptionSource<AgentSlashCommand, TConfig>;
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

/** The launch-time choices a caller made for one agent; every field is optional. */
export interface AgentLaunchSelection {
  modelId?: string | null;
  reasoningId?: string | null;
  modeId?: string | null;
  permissionModeId?: string | null;
  slashCommand?: string | null;
}

/** Options resolved from an agent's static lists or async providers. */
export interface ResolvedAgentOptions {
  modes: AgentMode[];
  permissionModes: AgentPermissionMode[];
  slashCommands: AgentSlashCommand[];
}

/** The default slash-command invocation: `/<name>`. */
export function defaultSlashCommandInvocation(name: string): string {
  return `/${name}`;
}

/** Resolves an option source (static list or async provider). */
export async function resolveAgentOptionSource<T, TConfig>(
  source: AgentOptionSource<T, TConfig> | undefined,
  ctx: PluginContext<TConfig>,
): Promise<T[]> {
  if (!source) return [];
  return typeof source === "function" ? source(ctx) : source;
}

/**
 * Resolves an agent's modes, permission modes, and slash commands. A provider
 * that throws degrades to an empty list for that option only, so a broken
 * slash-command scan never hides the agent's permission modes.
 */
export async function resolveAgentOptions<TConfig>(
  agent: AgentDefinition<TConfig>,
  ctx: PluginContext<TConfig>,
): Promise<ResolvedAgentOptions> {
  const settle = async <T>(source: AgentOptionSource<T, TConfig> | undefined): Promise<T[]> => {
    try {
      return await resolveAgentOptionSource(source, ctx);
    } catch {
      return [];
    }
  };
  const [modes, permissionModes, slashCommands] = await Promise.all([
    settle(agent.modes),
    settle(agent.permissionModes),
    settle(agent.slashCommands),
  ]);
  return { modes, permissionModes, slashCommands: dedupeSlashCommands(slashCommands) };
}

/** Keeps the first command per name, so a higher-priority source shadows a lower one. */
export function dedupeSlashCommands(commands: AgentSlashCommand[]): AgentSlashCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (!command.name || seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

/**
 * The text that invokes a command in this agent's TUI: the command's own
 * `invocation`, else `args.slashCommand`, else `/<name>`.
 */
export function slashCommandInvocation(
  agent: Pick<AgentDefinition, "args">,
  command: AgentSlashCommand | string,
): string {
  const entry = typeof command === "string" ? { name: command } : command;
  return (
    entry.invocation ??
    agent.args.slashCommand?.(entry.name) ??
    defaultSlashCommandInvocation(entry.name)
  );
}

/** Composes a launch prompt from a slash-command invocation and the user's input. */
export function applySlashCommand(invocation: string, input: string | null | undefined): string {
  const rest = input?.trim();
  return rest ? `${invocation} ${rest}` : invocation;
}

/**
 * Builds the argv appended to `launch.command` for a selection: model and
 * reasoning first, then the mode, then the permission mode. The mode and
 * permission mode fall back to the first declared entry (the default) when the
 * selection names none; `options` supplies resolved lists for async providers.
 */
export function agentLaunchArgs(
  agent: Pick<AgentDefinition, "args" | "modes" | "permissionModes">,
  selection: AgentLaunchSelection | null | undefined,
  options: Partial<Pick<ResolvedAgentOptions, "modes" | "permissionModes">> = {},
): string[] {
  const args = modelArgs(agent.args, selection);
  const modes = options.modes ?? staticList(agent.modes);
  const modeId = selection?.modeId ?? modes[0]?.id;
  if (modeId && agent.args.mode) {
    args.push(...agent.args.mode(modeId));
  }
  const permissionModes = options.permissionModes ?? staticList(agent.permissionModes);
  const permissionModeId = selection?.permissionModeId ?? permissionModes[0]?.id;
  if (permissionModeId) {
    args.push(...agent.args.permissionMode(permissionModeId));
  }
  return args;
}

/** Model/reasoning argv for a selection (the part the catalog precomputes per model). */
export function modelArgs(
  builder: AgentArgsBuilder,
  selection: Pick<AgentLaunchSelection, "modelId" | "reasoningId"> | null | undefined,
): string[] {
  const modelId = selection?.modelId;
  if (!modelId) return [];
  const reasoningId = selection.reasoningId;
  if (reasoningId && builder.modelReasoning) {
    return builder.modelReasoning(modelId, reasoningId);
  }
  return [...builder.model(modelId), ...(reasoningId ? builder.reasoning(reasoningId) : [])];
}

function staticList<T>(source: AgentOptionSource<T, never> | undefined): T[] {
  return Array.isArray(source) ? source : [];
}
