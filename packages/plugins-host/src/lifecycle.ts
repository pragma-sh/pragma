import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginContext } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import type { ResolvedPlugin } from "./catalog";

interface LifecycleState {
  installed: string[];
  loadedByServerBoot: Record<string, string>;
}

const STATE_FILE = "plugin-lifecycle.json";

/** Runs install and server-load hooks with durable completion markers. */
export async function runPluginLifecycles(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  root: string | undefined,
  stateDir: string,
  serverBootId: string,
  onError: (pluginId: string, hook: "onInstall" | "onPragmaLoad", error: unknown) => void,
): Promise<void> {
  const path = join(stateDir, STATE_FILE);
  const state = await readState(path);
  const installed = new Set(state.installed);

  for (const plugin of plugins) {
    const ctx = contextFor(plugin, sdk, root);
    if (!installed.has(plugin.pluginId)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- lifecycle callbacks run in plugin declaration order and duplicate ids execute once.
        await plugin.definition.onInstall?.(ctx);
        installed.add(plugin.pluginId);
        state.installed = [...installed].toSorted();
        // oxlint-disable-next-line no-await-in-loop -- persist each completion before another callback can run.
        await writeState(path, state);
      } catch (error) {
        onError(plugin.pluginId, "onInstall", error);
      }
    }
    if (state.loadedByServerBoot[plugin.pluginId] !== serverBootId) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- lifecycle callbacks run in plugin declaration order and duplicate ids execute once.
        await plugin.definition.onPragmaLoad?.(ctx);
        state.loadedByServerBoot[plugin.pluginId] = serverBootId;
        // oxlint-disable-next-line no-await-in-loop -- persist each completion before another callback can run.
        await writeState(path, state);
      } catch (error) {
        onError(plugin.pluginId, "onPragmaLoad", error);
      }
    }
  }
}

function contextFor(
  plugin: ResolvedPlugin,
  sdk: PragmaClient,
  root: string | undefined,
): PluginContext {
  return {
    pluginId: plugin.pluginId,
    pluginDir: plugin.dir,
    config: plugin.config,
    project:
      plugin.scope === "project"
        ? { id: plugin.root, name: plugin.root, path: plugin.root }
        : root
          ? { id: root, name: root, path: root }
          : null,
    sdk,
    notify: () => {},
  };
}

async function readState(path: string): Promise<LifecycleState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) return emptyState();
    return {
      installed: Array.isArray(value.installed)
        ? value.installed.filter((item): item is string => typeof item === "string")
        : [],
      loadedByServerBoot: isStringRecord(value.loadedByServerBoot) ? value.loadedByServerBoot : {},
    };
  } catch {
    return emptyState();
  }
}

async function writeState(path: string, state: LifecycleState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function emptyState(): LifecycleState {
  return { installed: [], loadedByServerBoot: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
