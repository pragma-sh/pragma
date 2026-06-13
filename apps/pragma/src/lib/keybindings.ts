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

/** Returns the chord for the requested platform from a platform chord definition. */
export function chordForPlatform(
  platformChord: PlatformChord,
  platform: KeybindingPlatform,
): KeybindingChord {
  return platformChord[platform];
}

/** Checks whether a keyboard event exactly matches a configured chord. */
export function chordMatches(event: KeyboardEvent, chord: KeybindingChord): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) {
    return false;
  }
  const required = new Set<Modifier>(chord.modifiers as Modifier[]);
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
