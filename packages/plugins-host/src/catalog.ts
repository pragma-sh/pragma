import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import type {
  AgentCatalog,
  AgentLaunchCommand,
  AgentModelEntry,
  CatalogAgent,
} from "@pragma/constants";
import type { AgentDefinition, PluginContext, PluginDefinition } from "@pragma/plugin";

/** Maximum icon size the catalog will serve, in bytes. */
export const ICON_MAX_BYTES = 256 * 1024;

/** A plugin definition tagged with the stable id it was resolved under. */
export interface ResolvedPlugin {
  pluginId: string;
  definition: PluginDefinition;
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
 * provider throwing) is reported via `onError` and skips that agent, never
 * failing the whole catalog.
 */
export async function assembleCatalog(
  plugins: ResolvedPlugin[],
  ctx: PluginContext,
  onError: (pluginId: string, agentId: string, error: unknown) => void = () => {},
): Promise<CatalogResult> {
  const agents: CatalogAgent[] = [];
  const assets: Record<string, IconAsset> = {};
  for (const { pluginId, definition } of plugins) {
    for (const agent of definition.agents ?? []) {
      try {
        agents.push(await catalogAgent(agent, pluginId, ctx, assets));
      } catch (error) {
        onError(pluginId, agent.id, error);
      }
    }
  }
  return { catalog: { agents }, assets };
}

async function catalogAgent(
  agent: AgentDefinition,
  pluginId: string,
  ctx: PluginContext,
  assets: Record<string, IconAsset>,
): Promise<CatalogAgent> {
  const models = await resolveModels(agent, ctx);
  const icon = catalogIcon(agent, assets);
  const commands = launchCommands(agent, models);
  const launch = catalogLaunch(agent, commands);
  return { id: agent.id, name: agent.name, pluginId, models, launch, ...(icon ? { icon } : {}) };
}

function catalogIcon(
  agent: AgentDefinition,
  assets: Record<string, IconAsset>,
): CatalogAgent["icon"] | undefined {
  if (!agent.iconPath) return undefined;
  const asset = hashIcon(agent.iconPath);
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
