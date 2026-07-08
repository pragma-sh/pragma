/** `pragma-plugins` host-side sidecar: resolves the agent catalog + icon assets. */
import { pathToFileURL } from "node:url";

import claudeCodeAgentPlugin from "@pragma/claude-code-plugin/pragma-agent";
import cursorAgentPlugin from "@pragma/cursor-plugin/pragma-agent";
import opencodeAgentPlugin from "@pragma/opencode-plugin/pragma-agent";
import type { PluginContext, PluginDefinition } from "@pragma/plugin";
import { PragmaClient } from "@pragma/sdk";
import { readStdinLines } from "@pragma/sidecar-kit";

import { assembleCatalog, type ResolvedPlugin } from "./catalog";
import { resolveManifests, type ResolvedManifest } from "./manifest";

interface LoadCommand {
  type: "load";
  roots?: string[];
  gatewayUrl: string;
  gatewayToken: string;
}

interface ReloadCommand {
  type: "reload";
}

type Command = LoadCommand | ReloadCommand;

/** Built-in agent plugins, tagged with their stable catalog plugin ids. */
const BUILTIN_PLUGINS: ResolvedPlugin[] = [
  { pluginId: "pragma.claude-code", definition: claudeCodeAgentPlugin },
  { pluginId: "pragma.opencode", definition: opencodeAgentPlugin },
  { pluginId: "pragma.cursor", definition: cursorAgentPlugin },
];

let lastLoad: LoadCommand | undefined;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitError(error: unknown): void {
  emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
}

function contextFor(sdk: PragmaClient, pluginId: string, root: string | undefined): PluginContext {
  return {
    pluginId,
    config: undefined,
    project: root ? { id: root, name: root, path: root } : null,
    sdk,
    notify: (message, options) => emit({ type: "log", pluginId, message, level: options?.variant }),
  };
}

async function loadConfigPlugin(manifest: ResolvedManifest): Promise<ResolvedPlugin | undefined> {
  try {
    const imported = (await import(pathToFileURL(manifest.mainPath).href)) as {
      default?: PluginDefinition;
    };
    return imported.default
      ? { pluginId: manifest.pluginId, definition: imported.default }
      : undefined;
  } catch (error) {
    emit({ type: "log", pluginId: manifest.pluginId, level: "error", message: String(error) });
    return undefined;
  }
}

async function resolveConfigPlugins(roots: string[]): Promise<ResolvedPlugin[]> {
  const home = process.env.HOME ?? "";
  const manifests = await resolveManifests(home, roots);
  const plugins = await Promise.all(manifests.map(loadConfigPlugin));
  return plugins.filter((plugin): plugin is ResolvedPlugin => plugin !== undefined);
}

async function load(command: LoadCommand): Promise<void> {
  lastLoad = command;
  const roots = command.roots ?? [];
  const sdk = new PragmaClient({ baseUrl: command.gatewayUrl, token: command.gatewayToken });
  const plugins = [...BUILTIN_PLUGINS, ...(await resolveConfigPlugins(roots))];
  // A single shared context (first root as project) resolves async model
  // providers, which shell out through the SDK to the local gateway.
  const ctx = contextFor(sdk, "pragma.catalog", roots[0]);
  const { catalog, assets } = await assembleCatalog(plugins, ctx, (pluginId, agentId, error) =>
    emit({
      type: "log",
      pluginId,
      level: "error",
      message: `agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  emit({ type: "catalog", catalog, assets });
}

async function handle(command: Command): Promise<void> {
  switch (command.type) {
    case "load":
      return load(command);
    case "reload":
      if (lastLoad) {
        return load(lastLoad);
      }
      return;
    default:
      return;
  }
}

class StdinLines {
  constructor() {
    readStdinLines((line) => void this.dispatch(line));
  }

  private async dispatch(line: string): Promise<void> {
    try {
      await handle(JSON.parse(line) as Command);
    } catch (error) {
      emitError(error);
    }
  }
}

process.on("unhandledRejection", (error) => emitError(error));
process.on("uncaughtException", (error) => emitError(error));

const stdinLines = new StdinLines();
void stdinLines;
emit({ type: "ready" });
process.stdin.resume();
