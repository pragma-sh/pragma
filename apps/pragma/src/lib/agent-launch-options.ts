import type { AgentMode, AgentPermissionMode, AgentSlashCommand } from "@pragma-sh/plugin";

const PERMISSION_STORAGE_PREFIX = "pragma:agent-permission-mode:";
/** Most rows the `/` picker renders at once. */
const SLASH_MENU_LIMIT = 50;

/**
 * The partial command name being typed when the prompt is exactly `/<query>`,
 * otherwise `null`. The picker only opens while the command name is the whole
 * prompt; typing a space commits the name and closes it.
 */
export function slashQuery(message: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(message.trim());
  return match ? match[1]! : null;
}

/** Commands matching `query`: name-prefix matches first, then substring matches. */
export function filterSlashCommands(
  commands: AgentSlashCommand[],
  query: string,
): AgentSlashCommand[] {
  const needle = query.toLowerCase();
  const prefix: AgentSlashCommand[] = [];
  const contains: AgentSlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle)) contains.push(command);
  }
  return [...prefix, ...contains].slice(0, SLASH_MENU_LIMIT);
}

/** What typing a command looks like in the picker: its own syntax, else `/name`. */
function invocation(command: AgentSlashCommand): string {
  return command.invocation ?? `/${command.name}`;
}

/**
 * The commands every list offers (by name, with the same invocation), in the
 * first list's order — what a fanout can type into all of its attempts.
 */
export function sharedSlashCommands(lists: readonly AgentSlashCommand[][]): AgentSlashCommand[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  return first.filter((command) =>
    rest.every((list) =>
      list.some(
        (other) => other.name === command.name && invocation(other) === invocation(command),
      ),
    ),
  );
}

/**
 * Splits a prompt that starts with a known `/command` into the command name and
 * the rest of the prompt. An unknown `/word` stays part of the prompt verbatim.
 */
export function splitSlashPrompt(
  message: string,
  commands: AgentSlashCommand[],
): { slashCommand: string | null; prompt: string } {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(message);
  const name = match?.[1];
  if (!name || !commands.some((command) => command.name === name)) {
    return { slashCommand: null, prompt: message };
  }
  return { slashCommand: name, prompt: match[2]?.trim() ?? "" };
}

/** What a key does while the `/` picker is open, or `null` when the editor keeps it. */
export type SlashMenuKeyAction = "next" | "previous" | "select" | null;

/** Classifies an editor key press for the open `/` picker. */
export function slashMenuKeyAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): SlashMenuKeyAction {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  const selects = event.key === "Enter" || (event.key === "Tab" && !event.shiftKey);
  return selects ? "select" : null;
}

/** The mode after `current`, wrapping around; the first mode when none is current. */
export function nextMode(modes: AgentMode[], current: string | null): string | null {
  if (modes.length === 0) return null;
  const index = modes.findIndex((mode) => mode.id === current);
  return modes[(index + 1) % modes.length]!.id;
}

/** The remembered permission mode for an agent when still offered, else its first (default). */
export function defaultPermissionMode(
  agentId: string,
  permissionModes: AgentPermissionMode[],
): string | null {
  const remembered = readStorage(`${PERMISSION_STORAGE_PREFIX}${agentId}`);
  if (remembered && permissionModes.some((mode) => mode.id === remembered)) {
    return remembered;
  }
  return permissionModes[0]?.id ?? null;
}

/** Persists the permission mode picked for an agent. */
export function rememberPermissionMode(agentId: string, permissionModeId: string): void {
  try {
    window.localStorage.setItem(`${PERMISSION_STORAGE_PREFIX}${agentId}`, permissionModeId);
  } catch {
    // Cosmetic preference only; storage failures must not block a launch.
  }
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
