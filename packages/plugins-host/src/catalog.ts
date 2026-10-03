import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

import type {
  AgentCatalog,
  AgentLaunchArgs,
  AgentLaunchCommand,
  AgentModelEntry,
  CatalogAgent,
} from "@pragma-sh/constants";
import type {
  AgentDefinition,
  PluginContext,
  PluginDefinition,
  ResolvedAgentOptions,
} from "@pragma-sh/plugin";
import { resolveAgentOptions, slashCommandInvocation } from "@pragma-sh/plugin/catalog";

/**
 * How long one agent's modes, permission modes, and slash commands may take to
 * resolve before the catalog stops waiting for them. Discovery can start the
 * tool itself (an ACP probe) and the server gives the whole catalog 30s, so a
 * slow tool falls back to its last-good (or static) options instead of
 * stalling every agent.
 */
const OPTIONS_BUDGET_MS = 10_000;

/**
 * Options that finished resolving after their budget, keyed by root + agent id.
 * The work is not cancelled, so its result is kept for the next catalog load
 * rather than thrown away — a tool that is slow under full-catalog contention
 * still shows its commands after one reload.
 */
const lateOptions = new Map<string, ResolvedAgentOptions>();

/** Maximum icon size the catalog will serve, in bytes. */
export const ICON_MAX_BYTES = 256 * 1024;

/** A loaded plugin definition plus the manifest facts the hosts need. */
export interface ResolvedPlugin {
  pluginId: string;
  scope: "global" | "project";
  root: string;
  /** Absolute plugin directory (relative icon paths resolve against it). */
  dir: string;
  /** Absolute path of the imported bundle (`pragma-watch` re-imports it). */
  mainPath: string;
  /** The plugin's config entry, passed through to its watcher instances. */
  config: unknown;
  definition: PluginDefinition;
}

/**
 * One watcher a plugin attaches to an agent, flattened for the server so a
 * headless launch can start the matching `pragma-watch` sidecar. Server-side
 * only — the config may hold secrets and must never ride the public catalog.
 */
export interface WatcherEntry {
  pluginId: string;
  agentId: string;
  watcherAgent: string;
  mainPath: string;
  config: unknown;
}

/** A hashed icon asset the gateway can serve by content hash. */
export interface IconAsset {
  hash: string;
  mime: string;
  path: string;
  /**
   * The icon's bytes, base64. Carried with the catalog so serving an icon never
   * re-reads the file: a plugin directory that moves or disappears between
   * catalog assembly and the request (a rebuilt dev worktree, a reinstalled npm
   * plugin) would otherwise fail *every* icon with `stat asset: No such file`
   * while the catalog still advertises the hashes.
   */
  base64: string;
}

/** The assembled catalog plus the hash → asset map the sidecar reports. */
export interface CatalogResult {
  catalog: AgentCatalog;
  assets: Record<string, IconAsset>;
  /**
   * Present when some agent's options overran their budget and the catalog used
   * a fallback; settles once that work finishes. A load run afterwards picks the
   * finished options up, so the host can republish them.
   */
  pending?: Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Returns the icon MIME type inferred from a file path's extension. */
export function mimeForIcon(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Reads an icon file, enforces the {@link ICON_MAX_BYTES} cap, and returns its
 * sha256 hash (lowercase hex) + MIME type. Throws when the file is missing or
 * exceeds the cap.
 */
export function hashIcon(path: string): IconAsset {
  const size = statSync(path).size;
  if (size > ICON_MAX_BYTES) {
    throw new Error(`icon exceeds ${ICON_MAX_BYTES} byte cap: ${path} (${size} bytes)`);
  }
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { hash, mime: mimeForIcon(path), path, base64: bytes.toString("base64") };
}

/** Resolves an agent's models, awaiting an async provider. */
export async function resolveModels(
  agent: AgentDefinition,
  ctx: PluginContext,
): Promise<AgentModelEntry[]> {
  const models = agent.models;
  return typeof models === "function" ? models(ctx) : models;
}

/**
 * Assembles the catalog from resolved plugins: resolves each agent's models,
 * hashes its icon (registering it in the asset map), and produces
 * {@link CatalogAgent} entries. A single agent's failure (bad icon, model
 * provider throwing or returning no models) is reported via `onError` and
 * falls back to the agent's entry in `previous` (the last successful catalog)
 * when one exists — a transient model-provider hiccup must not drop the agent
 * from the catalog — and only skips the agent when there is no last-good
 * entry, never failing the whole catalog.
 */
export async function assembleCatalog(
  plugins: ResolvedPlugin[],
  ctx: PluginContext | ((plugin: ResolvedPlugin) => PluginContext),
  onError: (pluginId: string, agentId: string, error: unknown) => void = () => {},
  previous?: CatalogResult,
  optionsBudgetMs: number = OPTIONS_BUDGET_MS,
): Promise<CatalogResult> {
  // A project-scoped plugin's model provider must resolve against the project
  // it was contributed by, not against whichever root happens to be first in
  // the registered list — that is how one project's `.pragma/config.json`
  // override leaked into another's launcher.
  const contextFor = typeof ctx === "function" ? ctx : () => ctx;
  const assets: Record<string, IconAsset> = {};
  const overdue: Promise<unknown>[] = [];
  const entries = plugins.flatMap((plugin) =>
    (plugin.definition.agents ?? []).map((agent) => ({ agent, plugin })),
  );
  const resolvedAgents = await Promise.all(
    entries.map(async ({ agent, plugin }) => {
      const fallback = lastGoodAgent(previous, qualifiedAgentId(plugin.pluginId, agent.id));
      try {
        const resolved = await catalogAgent(agent, plugin, contextFor(plugin), assets, {
          budgetMs: optionsBudgetMs,
          fallback,
          overdue,
        });
        if (resolved.models.length === 0 && fallback && fallback.models.length > 0) {
          onError(
            plugin.pluginId,
            agent.id,
            new Error("model provider returned no models; reusing last-good catalog entry"),
          );
          return adoptFallback(fallback, previous, assets);
        }
        return resolved;
      } catch (error) {
        onError(plugin.pluginId, agent.id, error);
        return fallback ? adoptFallback(fallback, previous, assets) : null;
      }
    }),
  );
  const agents = resolvedAgents.filter((agent): agent is CatalogAgent => agent !== null);
  const pending =
    overdue.length > 0 ? Promise.allSettled(overdue).then(() => undefined) : undefined;
  return { catalog: { agents }, assets, ...(pending ? { pending } : {}) };
}

/** The agent's entry in the last successfully assembled catalog, if any. */
function lastGoodAgent(previous: CatalogResult | undefined, id: string): CatalogAgent | undefined {
  return previous?.catalog.agents.find((agent) => agent.id === id);
}

/** Reuses a last-good agent entry, carrying its icon asset into the new map. */
function adoptFallback(
  agent: CatalogAgent,
  previous: CatalogResult | undefined,
  assets: Record<string, IconAsset>,
): CatalogAgent {
  const hash = agent.icon?.hash;
  const asset = hash ? previous?.assets[hash] : undefined;
  if (hash && asset) {
    assets[hash] = asset;
  }
  return agent;
}

/**
 * Flattens every plugin's watcher declarations into {@link WatcherEntry}s so
 * the server can start the matching `pragma-watch` sidecar for a headless
 * launch of any agent contributed by a configured plugin.
 */
export function assembleWatchers(plugins: ResolvedPlugin[]): WatcherEntry[] {
  return plugins.flatMap((plugin) =>
    (plugin.definition.watchers ?? []).map((watcher) => ({
      pluginId: plugin.pluginId,
      agentId: qualifiedAgentId(plugin.pluginId, watcher.agent),
      watcherAgent: watcher.agent,
      mainPath: plugin.mainPath,
      config: plugin.config ?? {},
    })),
  );
}

async function catalogAgent(
  agent: AgentDefinition,
  plugin: ResolvedPlugin,
  ctx: PluginContext,
  assets: Record<string, IconAsset>,
  budget: OptionsBudget,
): Promise<CatalogAgent> {
  const [models, options] = await Promise.all([
    resolveModels(agent, ctx),
    resolveOptionsWithinBudget(agent, plugin, ctx, budget),
  ]);
  const icon = catalogIcon(agent, plugin.dir, assets);
  const commands = launchCommands(agent, models);
  const launch = catalogLaunch(agent, commands, options);
  const runtimeAgentId = (plugin.definition.watchers ?? []).find(
    (watcher) => watcher.agent === agent.id,
  )?.agent;
  return {
    id: qualifiedAgentId(plugin.pluginId, agent.id),
    name: agent.name,
    pluginId: plugin.pluginId,
    scope: plugin.scope,
    root: plugin.root,
    ...(runtimeAgentId ? { runtimeAgentId } : {}),
    models,
    ...catalogOptions(agent, options),
    launch,
    ...(agent.excludeFeatures ? { excludeFeatures: agent.excludeFeatures } : {}),
    ...(icon ? { icon } : {}),
  };
}

/** How long an agent's options may take, and where to fall back and report overruns. */
interface OptionsBudget {
  budgetMs: number;
  /** The agent's last-good catalog entry. */
  fallback: CatalogAgent | undefined;
  /** Collects option work that overran its budget. */
  overdue: Promise<unknown>[];
}

/**
 * The agent's options, or — when they take longer than the budget — a late
 * result from an earlier load, its last-good catalog options, or its static
 * lists, in that order.
 */
function resolveOptionsWithinBudget(
  agent: AgentDefinition,
  plugin: ResolvedPlugin,
  ctx: PluginContext,
  budget: OptionsBudget,
): Promise<ResolvedAgentOptions> {
  const key = `${plugin.root}\0${qualifiedAgentId(plugin.pluginId, agent.id)}`;
  const work = resolveAgentOptions(agent, ctx).then((options) => {
    lateOptions.set(key, options);
    return options;
  });
  return withinBudget(work, budget.budgetMs, () => {
    budget.overdue.push(work);
    return lateOptions.get(key) ?? fallbackOptions(agent, budget.fallback);
  });
}

/** Resolves `work`, or `fallback()` once `ms` pass first. */
async function withinBudget<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The agent's last-good catalog options, else the lists it declares statically. */
function fallbackOptions(
  agent: AgentDefinition,
  previous: CatalogAgent | undefined,
): ResolvedAgentOptions {
  if (previous) {
    return {
      modes: (previous.modes ?? []).map(withoutNulls),
      permissionModes: (previous.permissionModes ?? []).map(withoutNulls),
      slashCommands: (previous.slashCommands ?? []).map(withoutNulls),
    };
  }
  return {
    modes: listed(agent.modes),
    permissionModes: listed(agent.permissionModes),
    slashCommands: listed(agent.slashCommands),
  };
}

/** A static option list, or nothing for an async provider. */
function listed<T>(source: unknown): T[] {
  return Array.isArray(source) ? (source as T[]) : [];
}

type WithoutNulls<T> = { [K in keyof T]: Exclude<T[K], null> };

/** Drops `null` fields: the wire types allow them where the plugin types use `undefined`. */
function withoutNulls<T extends object>(item: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}

/** Catalog agent id for a plugin-local agent id (shared with the desktop's `pluginAgentId`). */
export function qualifiedAgentId(pluginId: string, agentId: string): string {
  if (agentId.includes(".")) return agentId;
  return pluginId === `pragma.${agentId}` ? pluginId : `${pluginId}.${agentId}`;
}

function catalogIcon(
  agent: AgentDefinition,
  pluginDir: string,
  assets: Record<string, IconAsset>,
): CatalogAgent["icon"] | undefined {
  if (!agent.iconPath) return undefined;
  // Definitions declare icons relative to their plugin directory so the same
  // bundle works from any install location; absolute paths pass through.
  const path = isAbsolute(agent.iconPath) ? agent.iconPath : join(pluginDir, agent.iconPath);
  const asset = hashIcon(path);
  assets[asset.hash] = asset;
  return { hash: asset.hash, mime: asset.mime };
}

function launchCommands(agent: AgentDefinition, models: AgentModelEntry[]): AgentLaunchCommand[] {
  const commands: AgentLaunchCommand[] = [
    { modelId: null, reasoningId: null, command: agent.launch.command },
  ];
  for (const model of models) {
    commands.push(modelCommand(agent, model.id));
    for (const reasoning of model.reasoning ?? []) {
      commands.push(reasoningCommand(agent, model.id, reasoning.id));
    }
  }
  return commands;
}

function modelCommand(agent: AgentDefinition, modelId: string): AgentLaunchCommand {
  return {
    modelId,
    reasoningId: null,
    command: [...agent.launch.command, ...agent.args.model(modelId)],
  };
}

function reasoningCommand(
  agent: AgentDefinition,
  modelId: string,
  reasoningId: string,
): AgentLaunchCommand {
  const args = agent.args.modelReasoning
    ? agent.args.modelReasoning(modelId, reasoningId)
    : [...agent.args.model(modelId), ...agent.args.reasoning(reasoningId)];
  return { modelId, reasoningId, command: [...agent.launch.command, ...args] };
}

/**
 * The public option lists. Each slash command carries its resolved invocation
 * so a host without the plugin's JS (the headless server) can apply it.
 */
function catalogOptions(
  agent: AgentDefinition,
  options: ResolvedAgentOptions,
): Pick<CatalogAgent, "slashCommands" | "modes" | "permissionModes"> {
  return {
    ...(options.slashCommands.length > 0
      ? {
          slashCommands: options.slashCommands.map((command) => ({
            ...command,
            invocation: slashCommandInvocation(agent, command),
          })),
        }
      : {}),
    ...(options.modes.length > 0 ? { modes: options.modes } : {}),
    ...(options.permissionModes.length > 0 ? { permissionModes: options.permissionModes } : {}),
  };
}

function optionArgs(
  items: { id: string }[],
  build: ((id: string) => string[]) | undefined,
): AgentLaunchArgs[] {
  return build ? items.map((item) => ({ id: item.id, args: build(item.id) })) : [];
}

function catalogLaunch(
  agent: AgentDefinition,
  commands: AgentLaunchCommand[],
  options: ResolvedAgentOptions,
): CatalogAgent["launch"] {
  const modeArgs = optionArgs(options.modes, agent.args.mode);
  const permissionModeArgs = optionArgs(options.permissionModes, agent.args.permissionMode);
  const launch = {
    commands,
    ...(modeArgs.length > 0 ? { modeArgs } : {}),
    ...(permissionModeArgs.length > 0 ? { permissionModeArgs } : {}),
    ...(agent.startupInput ? { startupInput: agent.startupInput } : {}),
    ...(agent.prefillDelayMs !== undefined ? { prefillDelayMs: agent.prefillDelayMs } : {}),
    ...(agent.prefillMode ? { prefillMode: agent.prefillMode } : {}),
    ...(agent.prefillSubmit ? { prefillSubmit: agent.prefillSubmit } : {}),
    ...(agent.prefillSubmitDelayMs !== undefined
      ? { prefillSubmitDelayMs: agent.prefillSubmitDelayMs }
      : {}),
  };
  return launch;
}
