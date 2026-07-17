/** `pragma-plugins` host-side sidecar: resolves the agent catalog + icon assets. */
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { PluginContext, PluginDefinition } from "@pragma/plugin";
import { PragmaClient } from "@pragma/sdk";
import { readStdinLines } from "@pragma/sidecar-kit";

import { assembleCatalog, assembleWatchers, type ResolvedPlugin } from "./catalog";
import { resolveManifests, type ResolvedManifest } from "./manifest";
import { loadUsageLimits } from "./usage-limits";

interface LoadCommand {
  type: "load";
  roots?: string[];
  /** Directory holding the plugin bundles shipped with the app, if any. */
  bundledDir?: string;
  gatewayUrl: string;
  gatewayToken: string;
}

interface UsageLimitsCommand {
  type: "usageLimits";
  requestId: string;
  pluginId?: string;
}

type Command = LoadCommand | UsageLimitsCommand;

interface LoadedState {
  plugins: ResolvedPlugin[];
  sdk: PragmaClient;
  root?: string;
}

// Static agent definitions must be available while the gateway discovery file
// is still being written. Dynamic model providers fail individually, and the
// host re-sends `load` with real credentials once the gateway publishes them.
const UNAVAILABLE_GATEWAY_URL = "http://127.0.0.1:0";
const UNAVAILABLE_GATEWAY_TOKEN = "unavailable";

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

async function loadPlugin(manifest: ResolvedManifest): Promise<ResolvedPlugin | undefined> {
  try {
    const imported = (await import(await bundleImportUrl(manifest.mainPath))) as {
      default?: PluginDefinition;
    };
    return imported.default
      ? {
          pluginId: manifest.pluginId,
          dir: manifest.dir,
          mainPath: manifest.mainPath,
          config: manifest.config,
          definition: imported.default,
        }
      : undefined;
  } catch (error) {
    emit({ type: "log", pluginId: manifest.pluginId, level: "error", message: String(error) });
    return undefined;
  }
}

/**
 * Builds the import URL for a plugin bundle with its mtime as a query
 * parameter. The sidecar is long-lived and `reload` re-imports every bundle;
 * without cache-busting, the ESM module cache would keep serving the bytes
 * from the first import even after the bundle is rebuilt on disk.
 */
async function bundleImportUrl(mainPath: string): Promise<string> {
  const url = pathToFileURL(mainPath);
  try {
    url.searchParams.set("mtime", String((await stat(mainPath)).mtimeMs));
  } catch {
    // A missing bundle fails at import() below with the real error.
  }
  return url.href;
}

async function resolvePlugins(roots: string[], bundledDir?: string): Promise<ResolvedPlugin[]> {
  const home = process.env.HOME ?? "";
  const manifests = await resolveManifests(home, roots, bundledDir);
  const plugins = await Promise.all(manifests.map(loadPlugin));
  return plugins.filter((plugin): plugin is ResolvedPlugin => plugin !== undefined);
}

async function load(command: LoadCommand): Promise<{
  state: LoadedState;
  catalog: Awaited<ReturnType<typeof assembleCatalog>>;
  watchers: ReturnType<typeof assembleWatchers>;
}> {
  const roots = command.roots ?? [];
  const sdk = new PragmaClient({
    baseUrl: command.gatewayUrl || UNAVAILABLE_GATEWAY_URL,
    token: command.gatewayToken || UNAVAILABLE_GATEWAY_TOKEN,
  });
  const plugins = await resolvePlugins(roots, command.bundledDir);
  // A single shared context (first root as project) resolves async model
  // providers, which shell out through the SDK to the local gateway.
  const ctx = contextFor(sdk, "pragma.catalog", roots[0]);
  const catalog = await assembleCatalog(plugins, ctx, (pluginId, agentId, error) =>
    emit({
      type: "log",
      pluginId,
      level: "error",
      message: `agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  return {
    state: { plugins, sdk, root: roots[0] },
    catalog,
    watchers: assembleWatchers(plugins),
  };
}

class StdinLines {
  private loaded: LoadedState | undefined;

  constructor() {
    readStdinLines((line) => void this.dispatch(line));
  }

  private async dispatch(line: string): Promise<void> {
    try {
      const command = JSON.parse(line) as Command;
      if (command.type === "load") {
        const loaded = await load(command);
        this.loaded = loaded.state;
        emit({
          type: "catalog",
          catalog: loaded.catalog.catalog,
          assets: loaded.catalog.assets,
          watchers: loaded.watchers,
        });
        return;
      }
      await this.handleUsageLimits(command);
    } catch (error) {
      emitError(error);
    }
  }

  private async handleUsageLimits(command: UsageLimitsCommand): Promise<void> {
    if (!this.loaded) {
      emit({
        type: "usageLimits",
        requestId: command.requestId,
        error: "plugin catalog has not loaded",
      });
      return;
    }
    try {
      const providers = await loadUsageLimits(
        this.loaded.plugins,
        this.loaded.sdk,
        this.loaded.root,
        command.pluginId,
      );
      emit({ type: "usageLimits", requestId: command.requestId, providers });
    } catch (error) {
      emit({
        type: "usageLimits",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

process.on("unhandledRejection", (error) => emitError(error));
process.on("uncaughtException", (error) => emitError(error));

const stdinLines = new StdinLines();
void stdinLines;
emit({ type: "ready" });
process.stdin.resume();
