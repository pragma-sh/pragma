import { useEffect } from "react";

import type { CommandDefinition, PluginContext } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import { isTerminalEditingContext, isTextEditingContext } from "@/lib/native-editing";

import {
  clearActivePluginCommandKeybindings,
  commandForEvent,
  platformModifier,
  setActivePluginCommandKeybindings,
} from "./command-keybindings";
import { notifyFromPlugin, usePluginRuntimeState } from "./host-hooks";
import { useActivePlugins, type PluginRecord } from "./registry";

export { platformModifier };

export interface PluginCommandBinding {
  commandId: string;
  pluginId: string;
  chord: string;
  source: "command" | "keybindings";
}

export interface PluginCommandRecord {
  pluginId: string;
  record: PluginRecord;
  command: CommandDefinition;
  bindings: PluginCommandBinding[];
}

interface RuntimeServices {
  sdk: PragmaClient | null;
  project: PluginContext["project"];
}

/** Resolves loaded plugin commands plus their active keybinding provenance. */
export function resolvePluginCommands(records: readonly PluginRecord[]): PluginCommandRecord[] {
  const commands: PluginCommandRecord[] = [];
  for (const record of records) {
    if (record.status !== "loaded" || !record.definition) {
      continue;
    }
    const overrides = record.definition.keybindings?.bindings ?? {};
    for (const command of record.definition.commands ?? []) {
      const commandId = qualifiedCommandId(record.pluginId, command.id);
      const bindings: PluginCommandBinding[] = [];
      if (command.defaultBinding) {
        bindings.push({
          commandId,
          pluginId: record.pluginId,
          chord: command.defaultBinding,
          source: "command",
        });
      }
      const override = overrides[command.id] ?? overrides[commandId];
      if (override) {
        bindings.push({
          commandId,
          pluginId: record.pluginId,
          chord: override,
          source: "keybindings",
        });
      }
      commands.push({ pluginId: record.pluginId, record, command, bindings });
    }
  }
  return commands;
}

/** Registers active plugin command keyboard shortcuts. */
export function PluginCommandKeybindings(props: { activeProjectId: string | null }): null {
  const records = useActivePlugins(props.activeProjectId);
  const runtime = usePluginRuntimeState();
  useEffect(() => {
    const commands = resolvePluginCommands(records);
    setActivePluginCommandKeybindings(commands);
    function onKeyDown(event: KeyboardEvent): void {
      const activeElement = document.activeElement;
      if (
        event.defaultPrevented ||
        (isTextEditingContext(activeElement) && !isTerminalEditingContext(activeElement))
      ) {
        return;
      }
      const matched = commandForEvent(commands, event);
      if (!matched) {
        return;
      }
      event.preventDefault();
      void runPluginCommand(matched, runtime).catch((cause: unknown) => {
        notifyFromPlugin(`Plugin command "${matched.command.title}" failed`, {
          variant: "error",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearActivePluginCommandKeybindings();
    };
  }, [records, runtime]);
  return null;
}

async function runPluginCommand(
  command: PluginCommandRecord,
  runtime: RuntimeServices,
): Promise<void> {
  if (!runtime.sdk) {
    throw new Error("Pragma SDK is not connected yet");
  }
  await command.command.run({
    pluginId: command.pluginId,
    config: command.record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  });
}

function qualifiedCommandId(pluginId: string, commandId: string): string {
  return commandId.includes(".") ? commandId : `${pluginId}.${commandId}`;
}
