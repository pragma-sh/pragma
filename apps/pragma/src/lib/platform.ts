export const isMac =
  typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

export const modifierKey = isMac ? "Ctrl" : "Alt";

export function projectModifierPressed(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? e.ctrlKey : e.altKey;
}

export const modifierLabel = isMac ? "⌃" : "Alt";
