/** `pragma-plugins` host-side sidecar: resolves the agent catalog + icon assets. */
import { stat } from "node:fs/promises";

import type { PluginContext, PluginDefinition } from "@pragma-sh/plugin";
import { PragmaClient } from "@pragma-sh/sdk";
import { freshImportSpecifier, readStdinLines } from "@pragma-sh/sidecar-kit";

import {
  assembleCatalog,
  assembleWatchers,
  type CatalogResult,
  type ResolvedPlugin,
} from "./catalog";
import { runPluginLifecycles } from "./lifecycle";
import { resolveManifests, type ResolvedManifest } from "./manifest";
import { loadUsageLimits } from "./usage-limits";

interface LoadCommand {
  type: "load";
  roots?: string[];
  gatewayUrl: string;
  gatewayToken: string;
  stateDir: string;
  serverBootId: string;
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
          scope: manifest.scope,
          root: manifest.root,
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
 * The import specifier for a plugin bundle, versioned by its mtime. The sidecar
 * is long-lived and `reload` re-imports every bundle; without cache-busting the
 * ESM module cache keeps serving the bytes from the first import after the
 * bundle is rebuilt on disk (see `freshImportSpecifier` for why a `file:` URL
 * cannot carry the version).
 */
async function bundleImportUrl(mainPath: string): Promise<string> {
  try {
    return freshImportSpecifier(mainPath, (await stat(mainPath)).mtimeMs);
  } catch {
    // A missing bundle fails at import() below with the real error.
    return mainPath;
  }
}

async function resolvePlugins(roots: string[]): Promise<ResolvedPlugin[]> {
  const home = process.env.HOME ?? "";
  const manifests = await resolveManifests(home, roots);
  const plugins = await Promise.all(manifests.map(loadPlugin));
  return plugins.filter((plugin): plugin is ResolvedPlugin => plugin !== undefined);
}

async function load(
  command: LoadCommand,
  previous?: CatalogResult,
): Promise<{
  state: LoadedState;
  catalog: Awaited<ReturnType<typeof assembleCatalog>>;
  watchers: ReturnType<typeof assembleWatchers>;
}> {
  const roots = command.roots ?? [];
  const sdk = new PragmaClient({
    baseUrl: command.gatewayUrl || UNAVAILABLE_GATEWAY_URL,
    token: command.gatewayToken || UNAVAILABLE_GATEWAY_TOKEN,
  });
  const plugins = await resolvePlugins(roots);
  // Each plugin resolves its async model providers against its *own* project
  // root; a global plugin falls back to the primary root. Sharing
  // one context here let a project-scoped override answer for every project.
  const catalog = await assembleCatalog(
    plugins,
    (plugin) =>
      contextFor(sdk, plugin.pluginId, plugin.scope === "project" ? plugin.root : roots[0]),
    (pluginId, agentId, error) =>
      emit({
        type: "log",
        pluginId,
        level: "error",
        message: `agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    previous,
  );
  return {
    state: { plugins, sdk, root: roots[0] },
    catalog,
    watchers: assembleWatchers(plugins),
  };
}

class StdinLines {
  private loaded: LoadedState | undefined;
  /** Last successfully assembled catalog, the fallback for flaky providers. */
  private lastCatalog: CatalogResult | undefined;
  private queue = Promise.resolve();
  /** Counts `load` commands, so a follow-up never outruns a newer load. */
  private loadGeneration = 0;
  private lifecycleQueue = Promise.resolve();

  constructor() {
    readStdinLines(
      (line) => {
        this.queue = this.queue.then(() => this.dispatch(line));
      },
      () => process.exit(0),
    );
  }

  private async dispatch(line: string, followUp = false): Promise<void> {
    try {
      const command = JSON.parse(line) as Command;
      if (command.type === "load") {
        await this.handleLoad(command, line, followUp);
        return;
      }
      await this.handleUsageLimits(command);
    } catch (error) {
      emitError(error);
    }
  }

  /** Assembles and publishes the catalog; a follow-up reuses the load's generation. */
  private async handleLoad(command: LoadCommand, line: string, followUp: boolean): Promise<void> {
    const generation = followUp ? this.loadGeneration : ++this.loadGeneration;
    const loaded = await load(command, this.lastCatalog);
    this.loaded = loaded.state;
    this.lastCatalog = loaded.catalog;
    emit({
      type: "catalog",
      catalog: loaded.catalog.catalog,
      assets: loaded.catalog.assets,
      watchers: loaded.watchers,
    });
    this.scheduleLifecycles(command, loaded.state);
    if (!followUp) this.scheduleFollowUp(line, generation, loaded.catalog.pending);
  }

  /**
   * Options that overran their budget finish in the background; reload once
   * they have (a single follow-up), unless a newer load superseded this one.
   */
  private scheduleFollowUp(line: string, generation: number, pending?: Promise<void>): void {
    void pending?.then(() => {
      if (generation !== this.loadGeneration) return undefined;
      this.queue = this.queue.then(() => this.dispatch(line, true));
      return undefined;
    });
  }

  private scheduleLifecycles(command: LoadCommand, state: LoadedState): void {
    this.lifecycleQueue = this.lifecycleQueue.then(async () => {
      try {
        await runPluginLifecycles(
          state.plugins,
          state.sdk,
          state.root,
          command.stateDir,
          command.serverBootId,
          (pluginId, hook, error) =>
            emit({
              type: "log",
              pluginId,
              level: "error",
              message: `${hook}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        );
      } catch (error) {
        emit({
          type: "log",
          pluginId: "pragma.lifecycle",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    });
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
