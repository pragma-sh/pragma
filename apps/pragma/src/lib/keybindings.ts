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
    closeTopTab: {
      mac: { modifiers: ["cmd"], key: "w" },
      linux: { modifiers: ["ctrl"], key: "w" },
    },
    newTerminalTab: {
      mac: { modifiers: ["cmd"], key: "t" },
      linux: { modifiers: ["ctrl"], key: "t" },
    },
    newBrowserTab: {
      mac: { modifiers: ["cmd"], key: "b" },
      linux: { modifiers: ["ctrl"], key: "b" },
    },
    clearTerminal: {
      mac: { modifiers: ["cmd"], key: "k" },
      linux: { modifiers: ["ctrl"], key: "k" },
    },
    browserReload: {
      mac: { modifiers: ["cmd"], key: "r" },
      linux: { modifiers: ["ctrl"], key: "r" },
    },
    browserDevtools: {
      mac: { modifiers: ["cmd", "shift"], key: "i" },
      linux: { modifiers: ["ctrl", "shift"], key: "i" },
    },
    browserCopyUrl: {
      mac: { modifiers: ["cmd", "shift"], key: "c" },
      linux: { modifiers: ["ctrl", "shift"], key: "c" },
    },
    splitHorizontal: {
      mac: { modifiers: ["cmd"], key: "/" },
      linux: { modifiers: ["ctrl"], key: "/" },
    },
    splitVertical: {
      mac: { modifiers: ["cmd", "shift"], key: "/" },
      linux: { modifiers: ["ctrl", "shift"], key: "/" },
    },
    deleteFile: {
      mac: { modifiers: ["cmd"], key: "backspace" },
      linux: { modifiers: ["ctrl"], key: "delete" },
    },
    scrollTerminalBottom: {
      mac: { modifiers: ["cmd"], key: "end" },
      linux: { modifiers: ["ctrl"], key: "end" },
    },
    switchToWorkspace1: {
      mac: { modifiers: ["ctrl"], key: "1" },
      linux: { modifiers: ["alt"], key: "1" },
    },
    switchToWorkspace2: {
      mac: { modifiers: ["ctrl"], key: "2" },
      linux: { modifiers: ["alt"], key: "2" },
    },
    switchToWorkspace3: {
      mac: { modifiers: ["ctrl"], key: "3" },
      linux: { modifiers: ["alt"], key: "3" },
    },
    switchToWorkspace4: {
      mac: { modifiers: ["ctrl"], key: "4" },
      linux: { modifiers: ["alt"], key: "4" },
    },
    switchToWorkspace5: {
      mac: { modifiers: ["ctrl"], key: "5" },
      linux: { modifiers: ["alt"], key: "5" },
    },
    switchToWorkspace6: {
      mac: { modifiers: ["ctrl"], key: "6" },
      linux: { modifiers: ["alt"], key: "6" },
    },
    switchToWorkspace7: {
      mac: { modifiers: ["ctrl"], key: "7" },
      linux: { modifiers: ["alt"], key: "7" },
    },
    switchToWorkspace8: {
      mac: { modifiers: ["ctrl"], key: "8" },
      linux: { modifiers: ["alt"], key: "8" },
    },
    switchToWorkspace9: {
      mac: { modifiers: ["ctrl"], key: "9" },
      linux: { modifiers: ["alt"], key: "9" },
    },
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
