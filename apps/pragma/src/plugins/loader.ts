import type { PluginDefinition } from "@pragma/plugin";
import { PLUGIN_API_VERSION } from "@pragma/plugin/version";

import { errorMessage } from "@/lib/errors";
import { readPluginBundle, type PluginEntryResult } from "@/lib/tauri";
import type { PluginRecord } from "./registry";
import { checkPluginCompatibility } from "./semver";

/**
 * Loads plugin bundles resolved by the Rust side into evaluated
 * {@link PluginRecord}s. Owns the module cache (one import per resolved
 * path+version per app run — project switches never re-import) and the
 * per-entry failure policy: any failure produces a `failed` record and an
 * `onFailure` callback, never a silent skip.
 */

/** Injectable seams so the load pipeline is unit-testable without Tauri/blob imports. */
export interface PluginLoadContext {
  /** The `@pragma/plugin` version this host supports. Defaults to the real one. */
  hostApiVersion?: string;
  /** Maps a project root path to its project id for tagging project-scope records. */
  projectIdByPath?: (projectPath: string) => string | undefined;
  /** Reads a bundle's JS source. Defaults to the Tauri command. */
  readBundle?: (mainPath: string) => Promise<string>;
  /** Evaluates JS source as an ES module. Defaults to a blob-URL dynamic import. */
  importModule?: (source: string) => Promise<unknown>;
  /** Called once per failed record (the provider shows a toast). */
  onFailure?: (record: PluginRecord) => void;
  /** Non-fatal diagnostics (e.g. minor-version skew). Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** Evaluates JS source by importing it through a temporary blob URL. */
async function importViaBlobUrl(source: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Module cache: one import per resolved bundle path + package version per app run. */
const moduleCache = new Map<string, Promise<unknown>>();

function cacheKey(mainPath: string, version: string): string {
  return `${mainPath}@${version}`;
}

/** Drops cached modules for a bundle path so dev hot-reload can re-import it. */
export function invalidatePluginModule(mainPath: string): void {
  for (const key of moduleCache.keys()) {
    if (key.startsWith(`${mainPath}@`)) {
      moduleCache.delete(key);
    }
  }
}

/** Test helper: clears the whole module cache. */
export function clearPluginModuleCache(): void {
  moduleCache.clear();
}

/**
 * Resolves each config entry (in declaration order) to a plugin record:
 * imports the bundle (cached), checks API-version compatibility, validates the
 * entry's config against the plugin's zod schema, and tags the record with its
 * scope/project. Every failure yields a `failed` record plus an `onFailure`
 * callback — entries are never silently skipped.
 */
export async function loadPluginEntries(
  entries: PluginEntryResult[],
  context: PluginLoadContext = {},
): Promise<PluginRecord[]> {
  const records = await Promise.all(entries.map((entry) => loadEntry(entry, context)));
  for (const record of records) {
    if (record.status === "failed") {
      context.onFailure?.(record);
    }
  }
  return records;
}

/** Either a successfully produced value or a record-level failure message. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadEntry(
  entry: PluginEntryResult,
  context: PluginLoadContext,
): Promise<PluginRecord> {
  const base = recordBase(entry, context);
  if (entry.error !== null || entry.manifest === null) {
    return {
      ...base,
      status: "failed",
      error: entry.error ?? "plugin entry did not resolve to a manifest",
    };
  }
  const imported = await importDefinition(entry.manifest, context);
  if (!imported.ok) {
    return { ...base, status: "failed", error: imported.error };
  }
  const definition = imported.value;
  const versionError = checkApiVersion(definition, entry.manifest.name, context);
  if (versionError !== null) {
    return { ...base, status: "failed", error: versionError };
  }
  const config = validateConfig(definition, entry.config ?? undefined);
  if (!config.ok) {
    return { ...base, status: "failed", error: config.error };
  }
  return { ...base, status: "loaded", definition, config: config.value };
}

/** Imports a manifest's bundle (cached) and checks its default export shape. */
async function importDefinition(
  manifest: { mainPath: string; version: string },
  context: PluginLoadContext,
): Promise<Outcome<PluginDefinition>> {
  let moduleNamespace: unknown;
  try {
    moduleNamespace = await importCached(manifest.mainPath, manifest.version, context);
  } catch (cause) {
    return { ok: false, error: `failed to load bundle: ${errorMessage(cause)}` };
  }
  const definition = (moduleNamespace as { default?: unknown }).default;
  if (!isPluginDefinition(definition)) {
    return {
      ok: false,
      error: "bundle does not default-export a plugin created with definePlugin()",
    };
  }
  return { ok: true, value: definition };
}

/** Returns a refusal message for incompatible API majors; logs minor skew. */
function checkApiVersion(
  definition: PluginDefinition,
  pluginName: string,
  context: PluginLoadContext,
): string | null {
  const hostApiVersion = context.hostApiVersion ?? PLUGIN_API_VERSION;
  const compatibility = checkPluginCompatibility(definition.__apiVersion, hostApiVersion);
  if (compatibility.kind === "refuse") {
    return compatibility.message;
  }
  if (compatibility.kind === "warn") {
    (context.warn ?? console.warn)(`plugin "${pluginName}": ${compatibility.message}`);
  }
  return null;
}

/** Validates the entry's config with the plugin's zod schema, if it has one. */
function validateConfig(definition: PluginDefinition, config: unknown): Outcome<unknown> {
  if (!definition.config) {
    return { ok: true, value: config };
  }
  const result = definition.config.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `invalid plugin config: ${details}` };
  }
  return { ok: true, value: result.data };
}

/** Manifest-derived identity fields, falling back when the manifest is absent. */
function manifestFields(
  entry: PluginEntryResult,
): Pick<PluginRecord, "pluginId" | "version" | "dir" | "mainPath" | "modifiedMs"> {
  const manifest = entry.manifest;
  return {
    pluginId: manifest?.name ?? entry.specifier,
    version: manifest?.version ?? null,
    dir: manifest?.dir,
    mainPath: manifest?.mainPath,
    modifiedMs: manifest?.modifiedMs ?? null,
  };
}

/** Builds the scope/identity fields shared by success and failure records. */
function recordBase(entry: PluginEntryResult, context: PluginLoadContext): PluginRecord {
  return {
    ...manifestFields(entry),
    scope: entry.scope,
    status: "failed",
    config: entry.config ?? undefined,
    ...projectRecordFields(entry.projectPath, context),
  };
}

function projectRecordFields(
  projectPath: string | null,
  context: PluginLoadContext,
): Pick<PluginRecord, "projectPath"> | Pick<PluginRecord, "projectPath" | "projectId"> | object {
  if (projectPath === null) {
    return {};
  }
  const projectId = context.projectIdByPath?.(projectPath);
  return projectId === undefined ? { projectPath } : { projectPath, projectId };
}

async function importCached(
  mainPath: string,
  version: string,
  context: PluginLoadContext,
): Promise<unknown> {
  const key = cacheKey(mainPath, version);
  const cached = moduleCache.get(key);
  if (cached) {
    return cached;
  }
  const readBundle = context.readBundle ?? readPluginBundle;
  const importModule = context.importModule ?? importViaBlobUrl;
  const promise = readBundle(mainPath).then(importModule);
  moduleCache.set(key, promise);
  try {
    return await promise;
  } catch (cause) {
    // Don't cache failures — the user may fix the bundle and retry.
    moduleCache.delete(key);
    throw cause;
  }
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __apiVersion?: unknown }).__apiVersion === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}
