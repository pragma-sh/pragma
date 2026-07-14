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

/** Checks whether a keyboard event exactly matches a configured chord. */
export function chordMatches(event: KeyboardEvent, chord: KeybindingChord): boolean {
  const eventKey = event.key.toLowerCase();
  const chordKey = chord.key.toLowerCase();
  const required = new Set<Modifier>(chord.modifiers as Modifier[]);
  if (eventKey !== chordKey) {
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
