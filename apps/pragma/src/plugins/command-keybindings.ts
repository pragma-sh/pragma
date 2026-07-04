import { isMacPlatform } from "@/lib/platform";

type Modifier = "cmd" | "ctrl" | "alt" | "shift";

interface PluginCommandKeybinding {
  chord: string;
}

interface PluginCommandKeybindingRecord {
  bindings: readonly PluginCommandKeybinding[];
}

let activePluginCommands: readonly PluginCommandKeybindingRecord[] = [];

/** Returns the platform-specific modifier name plugin docs should display for `mod`. */
export function platformModifier(): "cmd" | "ctrl" {
  return isMacPlatform() ? "cmd" : "ctrl";
}

/** Updates active plugin command bindings for non-React key handlers like xterm. */
export function setActivePluginCommandKeybindings(
  commands: readonly PluginCommandKeybindingRecord[],
): void {
  activePluginCommands = commands;
}

/** Clears active plugin command bindings. */
export function clearActivePluginCommandKeybindings(): void {
  activePluginCommands = [];
}

/** Returns whether the event matches any active plugin command binding. */
export function hasPluginCommandForEvent(event: KeyboardEvent): boolean {
  return commandForEvent(activePluginCommands, event) !== null;
}

/** Finds the first plugin command whose binding matches a keyboard event. */
export function commandForEvent<TCommand extends PluginCommandKeybindingRecord>(
  commands: readonly TCommand[],
  event: KeyboardEvent,
): TCommand | null {
  for (const command of commands) {
    if (command.bindings.some((binding) => chordStringMatches(event, binding.chord))) {
      return command;
    }
  }
  return null;
}

function chordStringMatches(event: KeyboardEvent, chord: string): boolean {
  const parts = chord
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.at(-1);
  if (!key || !keyMatches(event, key)) {
    return false;
  }
  const modifiers = modifiersFromParts(parts.slice(0, -1));
  if (modifiers === null) {
    return false;
  }
  return (["cmd", "ctrl", "alt", "shift"] as const).every(
    (modifier) => modifierActive(event, modifier) === modifiers.has(modifier),
  );
}

function modifiersFromParts(parts: string[]): Set<Modifier> | null {
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = normalizeModifier(part);
    if (modifier === null) {
      return null;
    }
    modifiers.add(modifier);
  }
  return modifiers;
}

function normalizeModifier(modifier: string): Modifier | null {
  if (modifier === "mod") {
    return platformModifier();
  }
  if (modifier === "command" || modifier === "meta") {
    return "cmd";
  }
  if (modifier === "control") {
    return "ctrl";
  }
  if (modifier === "option") {
    return "alt";
  }
  if (modifier === "cmd" || modifier === "ctrl" || modifier === "alt" || modifier === "shift") {
    return modifier;
  }
  return null;
}

function keyMatches(event: KeyboardEvent, key: string): boolean {
  const eventKey = event.key.toLowerCase();
  if (key === "mod") {
    return false;
  }
  if (key === eventKey) {
    return true;
  }
  return key === "/" && eventKey === "?" && event.shiftKey;
}

function modifierActive(event: KeyboardEvent, modifier: Modifier): boolean {
  switch (modifier) {
    case "cmd":
      return event.metaKey;
    case "ctrl":
      return event.ctrlKey;
    case "alt":
      return event.altKey;
    case "shift":
      return event.shiftKey;
  }
}
