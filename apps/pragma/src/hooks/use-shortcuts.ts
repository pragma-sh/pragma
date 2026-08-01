import { useEffect, useRef, useState } from "react";

import type { KeybindingPlatform, KeybindingAction } from "@/lib/keybindings";
import {
  actionForEvent,
  defaultKeybindingsConfig,
  isRecordingKeybinding,
  KEYBINDINGS_CHANGED_EVENT,
  setLoadedKeybindingsConfig,
  workspaceIndexForAction,
} from "@/lib/keybindings";
import { isTerminalEditingContext, isTextEditingContext } from "@/lib/native-editing";
import { isMacPlatform } from "@/lib/platform";
import { hasPluginCommandForEvent } from "@/plugins/command-keybindings";
import { getPlatform, loadKeybindings } from "@/lib/tauri";

interface UseShortcutsOptions {
  /** Selected project, whose `.pragma/keybindings.json` overrides the global one. */
  projectId: string | null;
  projectCount: number;
  onProject: (index: number) => void;
  onNextTab: () => void;
  onPreviousTab: () => void;
  onCloseTopTab: () => void;
  onNewTerminalTab: () => void;
  onNewBrowserTab: () => void;
  onClearTerminal: () => void;
  /** Browser-only actions; the handler decides whether to act on the active tab. */
  onBrowserReload: () => void;
  onBrowserDevtools: () => void;
  onBrowserCopyUrl: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  /** Files tree: opens the delete confirmation for the currently selected file. */
  onDeleteSelectedFile: () => void;
  /** Scrolls the active terminal viewport to the bottom (live cursor row). */
  onScrollTerminalBottom: () => void;
  /** Opens project command palette. */
  onOpenCommandPalette: () => void;
  /** Opens project command palette directly in command mode. */
  onOpenCommandMode: () => void;
}

interface ShortcutState {
  platform: KeybindingPlatform;
  actionForEvent: (event: KeyboardEvent) => KeybindingAction | null;
}

/** Option keys whose handlers are zero-arg callbacks (no payload to forward). */
type ZeroArgOptionKey = {
  [K in keyof UseShortcutsOptions]: UseShortcutsOptions[K] extends () => void ? K : never;
}[keyof UseShortcutsOptions];

/** Simple actions that map 1:1 to a zero-arg option callback with preventDefault. */
const SIMPLE_ACTIONS: Partial<Record<KeybindingAction, ZeroArgOptionKey>> = {
  nextTab: "onNextTab",
  previousTab: "onPreviousTab",
  closeTopTab: "onCloseTopTab",
  newTerminalTab: "onNewTerminalTab",
  newBrowserTab: "onNewBrowserTab",
  browserReload: "onBrowserReload",
  browserDevtools: "onBrowserDevtools",
  browserCopyUrl: "onBrowserCopyUrl",
  splitHorizontal: "onSplitHorizontal",
  splitVertical: "onSplitVertical",
  scrollTerminalBottom: "onScrollTerminalBottom",
  openCommandPalette: "onOpenCommandPalette",
  openCommandMode: "onOpenCommandMode",
};

const NATIVE_MENU_ACTIONS: ReadonlySet<KeybindingAction> = new Set([
  "closeTopTab",
  "newTerminalTab",
  "openCommandPalette",
  "openCommandMode",
]);

/**
 * Registers window-level keyboard shortcuts driven by the effective keybindings:
 * built-in defaults, then `~/.pragma/keybindings.json`, then the selected
 * project's `.pragma/keybindings.json`. Reloads when the project changes or
 * Settings saves a binding.
 */
export function useShortcuts(options: UseShortcutsOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { projectId } = options;

  const [shortcutState, setShortcutState] = useState<ShortcutState>(() => {
    const platform = isMacPlatform() ? "mac" : "linux";
    return {
      platform,
      actionForEvent: (event) => actionForEvent(event, defaultKeybindingsConfig, platform),
    };
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [platform, config] = await Promise.all([getPlatform(), loadKeybindings(projectId)]);
        if (cancelled) {
          return;
        }
        setLoadedKeybindingsConfig(config);
        setShortcutState({
          platform,
          actionForEvent: (event) => actionForEvent(event, config, platform),
        });
      } catch {
        // Keep the built-in shortcuts active if the editable config is unavailable.
      }
    }
    void load();
    window.addEventListener(KEYBINDINGS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(KEYBINDINGS_CHANGED_EVENT, load);
    };
  }, [projectId]);

  useEffect(() => {
    const state = shortcutState;

    function onKeyDown(event: KeyboardEvent) {
      // While Settings records a chord, every key belongs to the recorder.
      if (isRecordingKeybinding()) {
        return;
      }
      const action = state.actionForEvent(event);
      if (!action) {
        return;
      }

      // Defer to active plugin command bindings (e.g. a plugin command bound to
      // `cmd+k`) so the plugin handler owns the chord instead of the built-in
      // app shortcut. Mirrors the bubble check in `terminal-manager.ts`.
      if (hasPluginCommandForEvent(event)) {
        return;
      }

      // Native menu accelerators own default chords that macOS/WebKit may consume
      // before the webview. Avoid running both native and webview handlers while
      // preserving configurable non-default chords.
      if (
        NATIVE_MENU_ACTIONS.has(action) &&
        actionForEvent(event, defaultKeybindingsConfig, state.platform) === action
      ) {
        return;
      }

      const current = optionsRef.current;
      const simpleKey = SIMPLE_ACTIONS[action];
      if (simpleKey) {
        event.preventDefault();
        current[simpleKey]();
        return;
      }

      if (action === "clearTerminal") {
        handleClearTerminalAction(event, current);
        return;
      }

      if (action === "deleteFile") {
        handleDeleteFileAction(event, current);
        return;
      }

      handleWorkspaceIndexAction(event, action, current);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutState]);
}

/**
 * `clearTerminal` (⌘/Ctrl+K by default) only applies inside a focused terminal.
 * Elsewhere the chord is free for the active surface — e.g. the editor's inline
 * AI edit — so we must not preventDefault outside `.xterm`.
 */
function handleClearTerminalAction(event: KeyboardEvent, current: UseShortcutsOptions): void {
  if (!isTerminalEditingContext(document.activeElement)) {
    return;
  }
  event.preventDefault();
  current.onClearTerminal();
}

/** `deleteFile` is a native OS text-editing chord in inputs/terminal/editor; only
 * treat it as "delete the selected file" outside a text-editing context. */
function handleDeleteFileAction(event: KeyboardEvent, current: UseShortcutsOptions): void {
  if (isTextEditingContext(document.activeElement)) {
    return;
  }
  event.preventDefault();
  current.onDeleteSelectedFile();
}

/** Workspace-index actions (Cmd/Ctrl+1..N) switch to the Nth project, in bounds. */
function handleWorkspaceIndexAction(
  event: KeyboardEvent,
  action: KeybindingAction,
  current: UseShortcutsOptions,
): void {
  const workspaceIndex = workspaceIndexForAction(action);
  if (workspaceIndex !== null && workspaceIndex <= current.projectCount) {
    event.preventDefault();
    current.onProject(workspaceIndex - 1);
  }
}
