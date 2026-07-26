import type { KeybindingChord, KeybindingsConfig, PlatformChord } from "@pragma/constants";

import {
  chordForPlatform,
  defaultKeybindingsConfig,
  normalizeChordKey,
  type KeybindingAction,
  type KeybindingPlatform,
} from "@/lib/keybindings";

/** Row labels for the Settings keybindings table, in the order they are shown. */
const ACTION_LABELS: Record<KeybindingAction, string> = {
  newTerminalTab: "New terminal tab",
  newBrowserTab: "New browser tab",
  closeTopTab: "Close tab",
  nextTab: "Next tab",
  previousTab: "Previous tab",
  splitHorizontal: "Split horizontally",
  splitVertical: "Split vertically",
  clearTerminal: "Clear terminal",
  scrollTerminalBottom: "Scroll terminal to bottom",
  browserReload: "Reload browser tab",
  browserDevtools: "Open browser devtools",
  browserCopyUrl: "Copy browser URL",
  deleteFile: "Delete selected file",
  openCommandPalette: "Open command palette",
  openCommandMode: "Open command mode",
  switchToWorkspace1: "Switch to project 1",
  switchToWorkspace2: "Switch to project 2",
  switchToWorkspace3: "Switch to project 3",
  switchToWorkspace4: "Switch to project 4",
  switchToWorkspace5: "Switch to project 5",
  switchToWorkspace6: "Switch to project 6",
  switchToWorkspace7: "Switch to project 7",
  switchToWorkspace8: "Switch to project 8",
  switchToWorkspace9: "Switch to project 9",
};

/** Every editable action, in table order. */
export const keybindingActions = Object.keys(ACTION_LABELS) as KeybindingAction[];

/** Human-readable name of an action, falling back to the raw action id. */
export function keybindingActionLabel(action: KeybindingAction): string {
  return ACTION_LABELS[action] ?? action;
}

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const LINUX_MODIFIER_LABELS: Record<string, string> = {
  cmd: "Super",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/** Display order matches the platform convention for stacked modifiers. */
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;

const KEY_LABELS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "Del",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  end: "End",
  home: "Home",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function keyLabel(key: string): string {
  const normalized = normalizeChordKey(key);
  const label = KEY_LABELS[normalized];
  if (label) return label;
  return normalized.length === 1 ? normalized.toUpperCase() : normalized;
}

/** Renders a chord the way the platform writes shortcuts. */
export function formatChord(chord: KeybindingChord, platform: KeybindingPlatform): string {
  const modifiers = MODIFIER_ORDER.filter((modifier) => chord.modifiers.includes(modifier));
  if (platform === "mac") {
    return `${modifiers.map((modifier) => MAC_MODIFIER_SYMBOLS[modifier]).join("")}${keyLabel(chord.key)}`;
  }
  return [
    ...modifiers.map((modifier) => LINUX_MODIFIER_LABELS[modifier]),
    keyLabel(chord.key),
  ].join("+");
}

/** Whether two chords require the same key and the same set of modifiers. */
export function chordsEqual(left: KeybindingChord, right: KeybindingChord): boolean {
  return (
    normalizeChordKey(left.key) === normalizeChordKey(right.key) &&
    left.modifiers.length === right.modifiers.length &&
    left.modifiers.every((modifier) => right.modifiers.includes(modifier))
  );
}

/** The built-in chord for an action on one platform. */
export function defaultChord(
  action: KeybindingAction,
  platform: KeybindingPlatform,
): KeybindingChord {
  return chordForPlatform(defaultKeybindingsConfig.bindings[action], platform);
}

/** Whether an action's effective chord still matches the built-in default. */
export function isDefaultChord(
  action: KeybindingAction,
  platform: KeybindingPlatform,
  config: KeybindingsConfig,
): boolean {
  return chordsEqual(
    chordForPlatform(config.bindings[action], platform),
    defaultChord(action, platform),
  );
}

/**
 * Builds a chord from a key press, or null when the press is only modifiers —
 * recording must wait for the real key rather than storing "just Shift".
 */
export function chordFromKeyboardEvent(event: KeyboardEvent): KeybindingChord | null {
  const key = normalizeChordKey(event.key);
  if (["shift", "control", "alt", "meta", "capslock", "dead", "unidentified"].includes(key)) {
    return null;
  }
  const modifiers: KeybindingChord["modifiers"] = [];
  if (event.metaKey) modifiers.push("cmd");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return { modifiers, key };
}

/**
 * The editable shape of a `keybindings.json` layer. Every field is optional: a
 * layer only carries the actions (and platforms) it overrides, so the global file
 * and a project file can be patched without inventing entries.
 */
export interface KeybindingOverrides {
  version?: number;
  bindings?: Partial<Record<KeybindingAction, Partial<PlatformChord>>>;
  [key: string]: unknown;
}

/** Parses one layer, treating a blank file as "no overrides". */
export function parseKeybindingOverrides(contents: string): KeybindingOverrides {
  if (!contents.trim()) return {};
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("keybindings.json root must be an object");
  }
  return value as KeybindingOverrides;
}

/** Serializes a layer the way the app writes JSON config files. */
export function serializeKeybindingOverrides(overrides: KeybindingOverrides): string {
  return `${JSON.stringify(overrides, null, 2)}\n`;
}

/** Sets one action's chord for one platform, leaving the other platform alone. */
export function withChordOverride(
  overrides: KeybindingOverrides,
  action: KeybindingAction,
  platform: KeybindingPlatform,
  chord: KeybindingChord,
): KeybindingOverrides {
  const bindings = { ...overrides.bindings };
  bindings[action] = { ...bindings[action], [platform]: chord };
  return { ...overrides, version: overrides.version ?? defaultKeybindingsConfig.version, bindings };
}

/**
 * Drops one action's chord for one platform. Emptied objects are removed so a
 * file that no longer overrides anything reads as clean as a fresh one.
 */
export function withoutChordOverride(
  overrides: KeybindingOverrides,
  action: KeybindingAction,
  platform: KeybindingPlatform,
): KeybindingOverrides {
  const existing = overrides.bindings?.[action];
  if (!existing) return overrides;
  const { [platform]: _removed, ...remaining } = existing;
  const bindings = { ...overrides.bindings };
  if (Object.keys(remaining).length === 0) {
    delete bindings[action];
  } else {
    bindings[action] = remaining;
  }
  const next: KeybindingOverrides = { ...overrides, bindings };
  if (Object.keys(bindings).length === 0) {
    delete next.bindings;
  }
  return next;
}
