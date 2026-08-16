import type {
  KeybindingChord,
  Keybindings,
  KeybindingsConfig,
  PlatformChord,
} from "@pragma/constants";

export type KeybindingAction = keyof Keybindings;
export type KeybindingPlatform = "mac" | "linux";

const MODIFIERS = ["cmd", "ctrl", "alt", "shift"] as const;

type Modifier = (typeof MODIFIERS)[number];

function primaryChord(key: string, shift = false): PlatformChord {
  const macModifiers: KeybindingChord["modifiers"] = shift ? ["cmd", "shift"] : ["cmd"];
  const linuxModifiers: KeybindingChord["modifiers"] = shift ? ["ctrl", "shift"] : ["ctrl"];
  return {
    mac: { modifiers: macModifiers, key },
    linux: { modifiers: linuxModifiers, key },
  };
}

function workspaceChord(key: string): PlatformChord {
  return {
    mac: { modifiers: ["ctrl"], key },
    linux: { modifiers: ["alt"], key },
  };
}

function worktreeChord(key: string): PlatformChord {
  return primaryChord(key);
}

function tabIndexChord(key: string): PlatformChord {
  return {
    mac: { modifiers: ["alt", "shift"], key },
    linux: { modifiers: ["alt", "shift"], key },
  };
}

/** Built-in keybindings used until the user config has loaded. */
export const defaultKeybindingsConfig: KeybindingsConfig = {
  version: 1,
  bindings: {
    nextTab: {
      mac: { modifiers: ["ctrl"], key: "tab" },
      linux: { modifiers: ["alt"], key: "tab" },
    },
    previousTab: {
      mac: { modifiers: ["ctrl", "shift"], key: "tab" },
      linux: { modifiers: ["alt", "shift"], key: "tab" },
    },
    closeTopTab: primaryChord("w"),
    newTerminalTab: primaryChord("t"),
    newBrowserTab: primaryChord("b"),
    clearTerminal: primaryChord("k"),
    browserReload: primaryChord("r"),
    browserDevtools: primaryChord("i", true),
    browserCopyUrl: primaryChord("c", true),
    splitHorizontal: primaryChord("/"),
    splitVertical: primaryChord("/", true),
    deleteFile: {
      mac: { modifiers: ["cmd"], key: "backspace" },
      linux: { modifiers: ["ctrl"], key: "delete" },
    },
    scrollTerminalBottom: primaryChord("end"),
    openCommandPalette: primaryChord("p"),
    openCommandMode: primaryChord("p", true),
    switchToWorkspace1: workspaceChord("1"),
    switchToWorkspace2: workspaceChord("2"),
    switchToWorkspace3: workspaceChord("3"),
    switchToWorkspace4: workspaceChord("4"),
    switchToWorkspace5: workspaceChord("5"),
    switchToWorkspace6: workspaceChord("6"),
    switchToWorkspace7: workspaceChord("7"),
    switchToWorkspace8: workspaceChord("8"),
    switchToWorkspace9: workspaceChord("9"),
    switchToWorktree1: worktreeChord("1"),
    switchToWorktree2: worktreeChord("2"),
    switchToWorktree3: worktreeChord("3"),
    switchToWorktree4: worktreeChord("4"),
    switchToWorktree5: worktreeChord("5"),
    switchToWorktree6: worktreeChord("6"),
    switchToWorktree7: worktreeChord("7"),
    switchToWorktree8: worktreeChord("8"),
    switchToWorktree9: worktreeChord("9"),
    switchToTab1: tabIndexChord("1"),
    switchToTab2: tabIndexChord("2"),
    switchToTab3: tabIndexChord("3"),
    switchToTab4: tabIndexChord("4"),
    switchToTab5: tabIndexChord("5"),
    switchToTab6: tabIndexChord("6"),
    switchToTab7: tabIndexChord("7"),
    switchToTab8: tabIndexChord("8"),
    switchToTab9: tabIndexChord("9"),
  },
};

let loadedKeybindingsConfig: KeybindingsConfig = defaultKeybindingsConfig;

/** Returns the current keybindings config (default until a user config is loaded). */
export function getKeybindingsConfig(): KeybindingsConfig {
  return loadedKeybindingsConfig;
}

/** Updates the current keybindings config, e.g. after loading `~/.pragma/keybindings.json`. */
export function setLoadedKeybindingsConfig(config: KeybindingsConfig): void {
  loadedKeybindingsConfig = config;
}

/** Returns the chord for the requested platform from a platform chord definition. */
export function chordForPlatform(
  platformChord: PlatformChord,
  platform: KeybindingPlatform,
): KeybindingChord {
  return platformChord[platform];
}

/**
 * Canonical form of a chord key, so a recorded chord and a hand-written config
 * entry compare equal. `KeyboardEvent.key` reports the space bar as `" "`, which
 * is unreadable in JSON, so it is stored and matched as `"space"`.
 */
export function normalizeChordKey(key: string): string {
  const lower = key.toLowerCase();
  return lower === " " ? "space" : lower;
}

/**
 * Window event fired after Settings writes a keybinding, so live shortcut
 * handlers reload without the user reopening the workspace.
 */
export const KEYBINDINGS_CHANGED_EVENT = "pragma:keybindings-changed";

// True while Settings is capturing a chord. Every shortcut handler bails out so
// the keys the user presses are recorded rather than acted on.
let recordingKeybinding = false;

/** Marks the start or end of a Settings keybinding recording session. */
export function setRecordingKeybinding(active: boolean): void {
  recordingKeybinding = active;
}

/** Whether Settings is currently capturing a chord instead of running actions. */
export function isRecordingKeybinding(): boolean {
  return recordingKeybinding;
}

/** Checks whether a keyboard event exactly matches a configured chord. */
export function chordMatches(event: KeyboardEvent, chord: KeybindingChord): boolean {
  const eventKey = normalizeChordKey(event.key);
  const chordKey = normalizeChordKey(chord.key);
  const required = new Set<Modifier>(chord.modifiers as Modifier[]);
  if (eventKey !== chordKey && !matchesPhysicalDigit(event, chordKey)) {
    // On US layouts Shift+/ produces "?", so accept it for configured "/" chords
    // that also require Shift (e.g. Cmd+Shift+/ for split vertical).
    if (!(chordKey === "/" && eventKey === "?" && required.has("shift"))) {
      return false;
    }
  }
  for (const modifier of MODIFIERS) {
    if (modifierActive(event, modifier) !== required.has(modifier)) {
      return false;
    }
  }
  return true;
}

function matchesPhysicalDigit(event: KeyboardEvent, chordKey: string): boolean {
  return (
    /^\d$/.test(chordKey) &&
    (event.code === `Digit${chordKey}` || event.code === `Numpad${chordKey}`)
  );
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

/** Checks only a chord's modifiers, used while revealing pending number shortcuts. */
export function chordModifiersMatch(event: KeyboardEvent, chord: KeybindingChord): boolean {
  if (chord.modifiers.length === 0) return false;
  const required = new Set<Modifier>(chord.modifiers as Modifier[]);
  return MODIFIERS.every((modifier) => modifierActive(event, modifier) === required.has(modifier));
}

/** Looks up the action (if any) that a keyboard event triggers for the current platform. */
export function actionForEvent(
  event: KeyboardEvent,
  config: KeybindingsConfig,
  platform: KeybindingPlatform,
): KeybindingAction | null {
  for (const [action, platformChord] of Object.entries(config.bindings)) {
    if (chordMatches(event, chordForPlatform(platformChord, platform))) {
      return action as KeybindingAction;
    }
  }
  return null;
}

/** Extracts a workspace index (1-9) from a switch-to-workspace action name. */
export function workspaceIndexForAction(action: KeybindingAction): number | null {
  const match = /^switchToWorkspace(\d)$/.exec(action);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

/** Extracts an index (1-9) from a switch-to-worktree action name. */
export function worktreeIndexForAction(action: KeybindingAction): number | null {
  const match = /^switchToWorktree(\d)$/.exec(action);
  return match ? Number(match[1]) : null;
}

/** Extracts an index (1-9) from a switch-to-tab action name. */
export function tabIndexForAction(action: KeybindingAction): number | null {
  const match = /^switchToTab(\d)$/.exec(action);
  return match ? Number(match[1]) : null;
}
