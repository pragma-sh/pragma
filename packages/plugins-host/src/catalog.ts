import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

import type {
  AgentCatalog,
  AgentLaunchCommand,
  AgentModelEntry,
  CatalogAgent,
} from "@pragma/constants";
import type { AgentDefinition, PluginContext, PluginDefinition } from "@pragma/plugin";

/** Maximum icon size the catalog will serve, in bytes. */
export const ICON_MAX_BYTES = 256 * 1024;

/** A loaded plugin definition plus the manifest facts the hosts need. */
export interface ResolvedPlugin {
  pluginId: string;
  scope: "bundled" | "global" | "project";
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
}

/** The assembled catalog plus the hash → asset map the sidecar reports. */
export interface CatalogResult {
  catalog: AgentCatalog;
  assets: Record<string, IconAsset>;
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
  return { hash, mime: mimeForIcon(path), path };
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
): Promise<CatalogResult> {
  // A project-scoped plugin's model provider must resolve against the project
  // it was contributed by, not against whichever root happens to be first in
  // the registered list — that is how one project's `.pragma/config.json`
  // override leaked into another's launcher.
  const contextFor = typeof ctx === "function" ? ctx : () => ctx;
  const assets: Record<string, IconAsset> = {};
  const entries = plugins.flatMap((plugin) =>
    (plugin.definition.agents ?? []).map((agent) => ({ agent, plugin })),
  );
  const resolvedAgents = await Promise.all(
    entries.map(async ({ agent, plugin }) => {
      const fallback = lastGoodAgent(previous, qualifiedAgentId(plugin.pluginId, agent.id));
      try {
        const resolved = await catalogAgent(agent, plugin, contextFor(plugin), assets);
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
  return { catalog: { agents }, assets };
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
 * launch of any agent — bundled and user-configured plugins alike.
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
): Promise<CatalogAgent> {
  const models = await resolveModels(agent, ctx);
  const icon = catalogIcon(agent, plugin.dir, assets);
  const commands = launchCommands(agent, models);
  const launch = catalogLaunch(agent, commands);
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
    launch,
    ...(agent.excludeFeatures ? { excludeFeatures: agent.excludeFeatures } : {}),
    ...(icon ? { icon } : {}),
  };
}

function qualifiedAgentId(pluginId: string, agentId: string): string {
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

function catalogLaunch(
  agent: AgentDefinition,
  commands: AgentLaunchCommand[],
): CatalogAgent["launch"] {
  const launch = {
    commands,
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
