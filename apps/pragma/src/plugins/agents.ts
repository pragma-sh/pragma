import { useSyncExternalStore } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import type { AgentDefinition, PluginContext } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import type { AgentConfig, AgentModel, AgentModelSelection, RawAgentModel } from "@/lib/tauri";

import { notifyFromPlugin } from "./host-hooks";
import type { PluginRecord } from "./registry";

interface RuntimeServices {
  sdk: PragmaClient | null;
  project: PluginContext["project"];
}

interface PluginAgentRecord {
  pluginId: string;
  record: PluginRecord;
  definition: AgentDefinition;
  config: AgentConfig;
}

const listeners = new Set<() => void>();
let records: PluginAgentRecord[] = [];
let configSnapshot: AgentConfig[] = [];
let runtime: RuntimeServices = { sdk: null, project: null };

/** Replaces active plugin-agent contributions for the current project scope. */
export function setPluginAgents(
  nextRecords: readonly PluginRecord[],
  nextRuntime: RuntimeServices,
): void {
  runtime = nextRuntime;
  records = nextRecords.flatMap(pluginAgentRecords);
  configSnapshot = records.map((record) => record.config);
  for (const listener of listeners) {
    listener();
  }
}

/** React hook returning launchable plugin-defined agents. */
export function usePluginAgents(): AgentConfig[] {
  return useSyncExternalStore(subscribe, pluginAgentConfigs, pluginAgentConfigs);
}

/** Returns current launchable plugin-defined agents outside React. */
export function listPluginAgents(): AgentConfig[] {
  return pluginAgentConfigs();
}

/** Resolves models for a plugin-defined agent, or `null` when the id is not plugin-owned. */
export async function resolvePluginAgentModels(agentId: string): Promise<AgentModel[] | null> {
  const record = records.find((candidate) => candidate.config.id === agentId);
  if (!record) {
    return null;
  }
  const models = record.definition.models;
  if (Array.isArray(models)) {
    return models.map(toAgentModel);
  }
  if (!runtime.sdk) {
    // Dynamic model lookups need the gateway SDK. Failing (instead of resolving
    // to an empty list) keeps the session cache from pinning "no models" when
    // the picker races the gateway connection at startup.
    throw new Error("Pragma SDK is not connected yet");
  }
  return (await models(pluginContext(record))).map(toAgentModel);
}

/** Builds plugin-owned launch args, or `null` when the agent is not plugin-owned. */
export function pluginAgentLaunchArgs(
  agentId: string,
  selection: AgentModelSelection | null | undefined,
): string[] | null {
  const record = records.find((candidate) => candidate.config.id === agentId);
  if (!record) {
    return null;
  }
  const args: string[] = [];
  if (selection?.modelId) {
    const reasoningId = selection.reasoningId;
    if (reasoningId && record.definition.args.modelReasoning) {
      args.push(...record.definition.args.modelReasoning(selection.modelId, reasoningId));
    } else {
      args.push(...record.definition.args.model(selection.modelId));
      if (reasoningId) {
        args.push(...record.definition.args.reasoning(reasoningId));
      }
    }
  }
  return args;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function pluginAgentConfigs(): AgentConfig[] {
  return configSnapshot;
}

function pluginAgentRecords(record: PluginRecord): PluginAgentRecord[] {
  if (record.status !== "loaded" || !record.definition) {
    return [];
  }
  return (record.definition.agents ?? []).map((definition) => ({
    pluginId: record.pluginId,
    record,
    definition,
    config: toAgentConfig(record.pluginId, definition, record),
  }));
}

function toAgentConfig(
  pluginId: string,
  definition: AgentDefinition,
  record: PluginRecord,
): AgentConfig {
  const staticModels = Array.isArray(definition.models)
    ? definition.models.map(toRawAgentModel)
    : [];
  return {
    id: pluginAgentId(pluginId, definition.id),
    name: definition.name,
    iconPath: resolveIconPath(definition.iconPath, record),
    iconDataUrl: null,
    start: definition.launch.command,
    startupInput: definition.startupInput ?? null,
    prefillDelayMs: definition.prefillDelayMs ?? null,
    prefillMode: definition.prefillMode ?? null,
    prefillSubmit: definition.prefillSubmit ?? null,
    prefillSubmitDelayMs: definition.prefillSubmitDelayMs ?? null,
    models: staticModels.length > 0 ? { source: "static", items: staticModels } : null,
  };
}

export function pluginAgentId(pluginId: string, agentId: string): string {
  if (pluginId === `pragma.${agentId}`) return pluginId;
  return agentId.includes(".") ? agentId : `${pluginId}.${agentId}`;
}

function resolveIconPath(iconPath: string | undefined, record: PluginRecord): string | null {
  if (!iconPath) {
    return null;
  }
  if (isBrowserUrl(iconPath)) {
    return iconPath;
  }
  const absolutePath = iconPath.startsWith("/")
    ? iconPath
    : record.dir
      ? `${record.dir.replace(/\/$/, "")}/${iconPath.replace(/^\.\//, "")}`
      : iconPath;
  return absolutePath.startsWith("/") ? convertFileSrc(absolutePath) : absolutePath;
}

function isBrowserUrl(iconPath: string): boolean {
  return /^(?:data:|blob:|https?:)/.test(iconPath);
}

function toRawAgentModel(model: RawAgentModel): RawAgentModel {
  return { id: model.id, name: model.name, reasoning: model.reasoning ?? [] };
}

function toAgentModel(model: RawAgentModel): AgentModel {
  return { id: model.id, name: model.name, reasoning: model.reasoning ?? [] };
}

function pluginContext(record: PluginAgentRecord): PluginContext {
  if (!runtime.sdk) {
    throw new Error("Pragma SDK is not connected yet");
  }
  return {
    pluginId: record.pluginId,
    config: record.record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  };
}
