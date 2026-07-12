import { useSyncExternalStore } from "react";

import type { PluginDefinition } from "@pragma/plugin";

/** Where a plugin was declared. */
export type PluginScope = "bundled" | "global" | "project";

/** Load status of one plugin entry. */
export type PluginStatus = "loaded" | "failed" | "disabled";

/** One plugin tracked by the registry. */
export interface PluginRecord {
  /** Stable id — the plugin's `package.json` name (or its specifier when resolution failed). */
  pluginId: string;
  /** Resolved package version, when known. */
  version: string | null;
  /** Absolute plugin directory when resolved from a manifest. */
  dir?: string;
  /** Absolute plugin bundle path when resolved from a manifest. */
  mainPath?: string;
  scope: PluginScope;
  /** Owning project id for `scope: "project"` records. */
  projectId?: string;
  /** Owning project root path for `scope: "project"` records. */
  projectPath?: string;
  status: PluginStatus;
  /** Failure/disable reason when `status` is not `"loaded"`. */
  error?: string;
  /** The evaluated plugin definition when `status` is `"loaded"`. */
  definition?: PluginDefinition;
  /** The entry's config after zod validation (schema output, not raw input). */
  config: unknown;
  /** Bundle mtime at load time (dev hot-reload change detection). */
  modifiedMs?: number | null;
}

/** A single contribution tagged with its origin, ready for host rendering. */
export interface TaggedContribution<T> {
  pluginId: string;
  scope: PluginScope;
  projectId?: string;
  contribution: T;
}

type Listener = () => void;

const listeners = new Set<Listener>();
/** Records grouped by scope key so scopes can be replaced independently. */
const groups = new Map<string, PluginRecord[]>();
let snapshot: PluginRecord[] = [];

function emit(): void {
  snapshot = [
    ...(groups.get(scopeKey("bundled")) ?? []),
    ...(groups.get(scopeKey("global")) ?? []),
  ];
  for (const [key, records] of groups) {
    if (key.startsWith("project:")) {
      snapshot = [...snapshot, ...records];
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

function scopeKey(scope: PluginScope, projectPath?: string): string {
  return scope === "project" ? `project:${projectPath ?? ""}` : scope;
}

/**
 * Replaces every record belonging to one scope (and, for project scope, one
 * project). Other scopes' records — including cached records for inactive
 * projects — are left untouched, so switching projects never drops state.
 */
export function setPluginsForScope(
  scope: PluginScope,
  projectPath: string | null,
  records: PluginRecord[],
): void {
  groups.set(scopeKey(scope, projectPath ?? undefined), records);
  emit();
}

/** Replaces a single plugin's record in place (dev hot-reload). */
export function replacePlugin(record: PluginRecord): void {
  const key = scopeKey(record.scope, record.projectPath);
  const records = groups.get(key) ?? [];
  const index = records.findIndex((existing) => existing.pluginId === record.pluginId);
  if (index === -1) {
    groups.set(key, [...records, record]);
  } else {
    groups.set(
      key,
      records.map((existing, i) => (i === index ? record : existing)),
    );
  }
  emit();
}

/** Removes every record (test helper). */
export function clearPlugins(): void {
  groups.clear();
  emit();
}

/** Every known plugin record, including cached records for inactive projects. */
export function getAllPlugins(): PluginRecord[] {
  return snapshot;
}

/**
 * Records visible for the given active project: builtins, globals, and only
 * the active project's records. Inactive projects' records stay cached in the
 * registry but are filtered out here.
 */
export function getActivePlugins(activeProjectId: string | null): PluginRecord[] {
  return snapshot.filter(
    (record) => record.scope !== "project" || record.projectId === activeProjectId,
  );
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function usePlugins(): PluginRecord[] {
  return useSyncExternalStore(subscribe, getAllPlugins, getAllPlugins);
}

/** React hook: records visible to the active project. */
export function useActivePlugins(activeProjectId: string | null): PluginRecord[] {
  return usePlugins().filter(
    (record) => record.scope !== "project" || record.projectId === activeProjectId,
  );
}

/** Collects one kind of contribution from loaded, visible plugins, tagged with its origin. */
export function collectContributions<T>(
  records: PluginRecord[],
  select: (definition: PluginDefinition) => T[] | undefined,
): TaggedContribution<T>[] {
  const tagged: TaggedContribution<T>[] = [];
  for (const record of records) {
    if (record.status !== "loaded" || !record.definition) {
      continue;
    }
    for (const contribution of select(record.definition) ?? []) {
      tagged.push({
        pluginId: record.pluginId,
        scope: record.scope,
        ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
        contribution,
      });
    }
  }
  return tagged;
}
