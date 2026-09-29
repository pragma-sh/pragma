import { useSyncExternalStore } from "react";

import type { AgentDefinition, PluginContext, ResolvedAgentOptions } from "@pragma-sh/plugin";
import {
  agentLaunchArgs,
  applySlashCommand,
  resolveAgentOptions,
  slashCommandInvocation,
} from "@pragma-sh/plugin/catalog";
import type { PragmaClient } from "@pragma-sh/sdk";

import { splitSlashPrompt } from "@/lib/agent-launch-options";
import type { AgentConfig, AgentModel, AgentModelSelection, RawAgentModel } from "@/lib/tauri";

import { notifyFromPlugin } from "./host-hooks";
import { resolvePluginAssetPath } from "./assets";
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
/** Last resolved modes/permission modes/slash commands per agent id. */
let optionsByAgent = new Map<string, ResolvedAgentOptions>();

/** Replaces active plugin-agent contributions for the current project scope. */
export function setPluginAgents(
  nextRecords: readonly PluginRecord[],
  nextRuntime: RuntimeServices,
): void {
  runtime = nextRuntime;
  records = nextRecords.flatMap(pluginAgentRecords);
  optionsByAgent = new Map();
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

/**
 * Resolves an agent's modes, permission modes, and slash commands, or `null`
 * when the id is not plugin-owned. Async providers need the gateway SDK; until
 * it connects only static lists are returned (and not cached).
 */
export async function resolvePluginAgentOptions(
  agentId: string,
): Promise<ResolvedAgentOptions | null> {
  const record = findRecord(agentId);
  if (!record) {
    return null;
  }
  if (!runtime.sdk) {
    return staticOptions(record.definition);
  }
  const options = await resolveAgentOptions(record.definition, pluginContext(record));
  optionsByAgent.set(agentId, options);
  return options;
}

/**
 * Builds plugin-owned launch args — model/reasoning, then mode, then permission
 * mode — or `null` when the agent is not plugin-owned. Unselected modes fall
 * back to the first declared entry, using the last resolved options for async
 * providers (see {@link resolvePluginAgentOptions}).
 */
export function pluginAgentLaunchArgs(
  agentId: string,
  selection: AgentModelSelection | null | undefined,
): string[] | null {
  const record = findRecord(agentId);
  if (!record) {
    return null;
  }
  return agentLaunchArgs(record.definition, selection, optionsByAgent.get(agentId) ?? {});
}

/**
 * The prompt to prefill for a launch: the slash command's invocation followed
 * by `prompt`. Without an explicit command, a prompt that starts with a known
 * `/command` is rewritten only when the agent invokes it differently.
 */
export function pluginAgentPrompt(
  agentId: string,
  slashCommand: string | null | undefined,
  prompt: string | undefined,
): string | undefined {
  const record = findRecord(agentId);
  const commands = optionsByAgent.get(agentId)?.slashCommands;
  const invocation = (name: string) => {
    const command = commands?.find((candidate) => candidate.name === name) ?? name;
    return record ? slashCommandInvocation(record.definition, command) : `/${name}`;
  };
  if (slashCommand) {
    return applySlashCommand(invocation(slashCommand), prompt);
  }
  if (!prompt || !commands) {
    return prompt;
  }
  const typed = splitSlashPrompt(prompt, commands);
  if (!typed.slashCommand || invocation(typed.slashCommand) === `/${typed.slashCommand}`) {
    return prompt;
  }
  return applySlashCommand(invocation(typed.slashCommand), typed.prompt);
}

function findRecord(agentId: string): PluginAgentRecord | undefined {
  return records.find((candidate) => candidate.config.id === agentId);
}

function staticList<T>(source: T[] | ((...args: never[]) => unknown) | undefined): T[] {
  return Array.isArray(source) ? source : [];
}

function staticOptions(definition: AgentDefinition): ResolvedAgentOptions {
  return {
    modes: staticList(definition.modes),
    permissionModes: staticList(definition.permissionModes),
    slashCommands: staticList(definition.slashCommands),
  };
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
    iconPath: resolvePluginAssetPath(definition.iconPath, record),
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

function pluginAgentId(pluginId: string, agentId: string): string {
  if (pluginId === `pragma.${agentId}`) return pluginId;
  return agentId.includes(".") ? agentId : `${pluginId}.${agentId}`;
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
    ...(record.record.dir === undefined ? {} : { pluginDir: record.record.dir }),
    config: record.record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  };
}
