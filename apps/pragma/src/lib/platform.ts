/** Returns true on macOS-like platforms. */
export function isMacPlatform(platform = navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** Pragma uses Ctrl on macOS and Alt on Linux for workspace shortcuts. */
export function workspaceModifier(platform = navigator.platform): "ctrl" | "alt" {
  return isMacPlatform(platform) ? "ctrl" : "alt";
}

/** Human-readable shortcut modifier label. */
export function workspaceModifierLabel(platform = navigator.platform): string {
  return workspaceModifier(platform) === "ctrl" ? "Ctrl" : "Alt";
}

/** Checks whether the configured workspace modifier is active for an event. */
export function hasWorkspaceModifier(event: KeyboardEvent, platform = navigator.platform): boolean {
  return workspaceModifier(platform) === "ctrl" ? event.ctrlKey : event.altKey;
}
