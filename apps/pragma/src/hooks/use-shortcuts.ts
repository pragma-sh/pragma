import { useEffect, useRef, useState } from "react";

import type { KeybindingsConfig } from "@pragma/constants";

import type { KeybindingPlatform, KeybindingAction } from "@/lib/keybindings";
import {
  actionForEvent,
  chordForPlatform,
  chordModifiersMatch,
  defaultKeybindingsConfig,
  isRecordingKeybinding,
  KEYBINDINGS_CHANGED_EVENT,
  setLoadedKeybindingsConfig,
  tabIndexForAction,
  worktreeIndexForAction,
  workspaceIndexForAction,
} from "@/lib/keybindings";
import { emptyShortcutHints, type ShortcutHints } from "@/lib/shortcut-hints";
import { isTerminalEditingContext, isTextEditingContext } from "@/lib/native-editing";
import { isMacPlatform } from "@/lib/platform";
import { hasPluginCommandForEvent } from "@/plugins/command-keybindings";
import { getPlatform, loadKeybindings } from "@/lib/tauri";

interface UseShortcutsOptions {
  /** Selected project, whose `.pragma/keybindings.json` overrides the global one. */
  projectId: string | null;
  projectCount: number;
  onProject: (index: number) => void;
  worktreeCount: number;
  onWorktree: (index: number) => void;
  tabCount: number;
  onTab: (index: number) => void;
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
  config: KeybindingsConfig;
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
export function useShortcuts(options: UseShortcutsOptions): ShortcutHints {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { projectId } = options;

  const [shortcutState, setShortcutState] = useState<ShortcutState>(() => {
    const platform = isMacPlatform() ? "mac" : "linux";
    return {
      platform,
      config: defaultKeybindingsConfig,
      actionForEvent: (event) => actionForEvent(event, defaultKeybindingsConfig, platform),
    };
  });
  const [hints, setHints] = useState<ShortcutHints>(emptyShortcutHints);

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
          config,
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
      if (isModifierKey(event.key)) {
        setHints(navigationHintsForEvent(event, state));
      }
      // While Settings records a chord, every key belongs to the recorder.
      if (isRecordingKeybinding()) {
        return;
      }
      const action = state.actionForEvent(event);
      if (!action) {
        return;
      }

      if (shouldIgnoreShortcut(event, action, state)) return;
      runShortcutAction(event, action, optionsRef.current);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (isModifierKey(event.key)) {
        setHints(navigationHintsForEvent(event, state));
      }
    }

    function clearHints() {
      setHints(emptyShortcutHints);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", clearHints);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", clearHints);
    };
  }, [shortcutState]);

  return hints;
}

function shouldIgnoreShortcut(
  event: KeyboardEvent,
  action: KeybindingAction,
  state: ShortcutState,
): boolean {
  // Plugin bindings own their chords; native menus own unchanged default chords.
  return (
    hasPluginCommandForEvent(event) ||
    (NATIVE_MENU_ACTIONS.has(action) &&
      actionForEvent(event, defaultKeybindingsConfig, state.platform) === action)
  );
}

function runShortcutAction(
  event: KeyboardEvent,
  action: KeybindingAction,
  current: UseShortcutsOptions,
): void {
  const simpleKey = SIMPLE_ACTIONS[action];
  if (simpleKey) {
    event.preventDefault();
    current[simpleKey]();
  } else if (action === "clearTerminal") {
    handleClearTerminalAction(event, current);
  } else if (action === "deleteFile") {
    handleDeleteFileAction(event, current);
  } else {
    handleNavigationIndexAction(event, action, current);
  }
}

function isModifierKey(key: string): boolean {
  return ["Alt", "Control", "Meta", "Shift"].includes(key);
}

function hintKey(key: string): string {
  const normalized = key.toLowerCase();
  return normalized.length === 1 ? normalized.toUpperCase() : normalized;
}

/** Resolves only number-navigation actions whose configured modifiers are currently held. */
function navigationHintsForEvent(event: KeyboardEvent, state: ShortcutState): ShortcutHints {
  const hints: {
    projects: Record<number, string>;
    worktrees: Record<number, string>;
    tabs: Record<number, string>;
  } = {
    projects: {},
    worktrees: {},
    tabs: {},
  };
  for (const action of Object.keys(state.config.bindings) as KeybindingAction[]) {
    const chord = chordForPlatform(state.config.bindings[action], state.platform);
    if (!chordModifiersMatch(event, chord)) continue;
    const projectIndex = workspaceIndexForAction(action);
    if (projectIndex !== null) hints.projects[projectIndex] = hintKey(chord.key);
    const worktreeIndex = worktreeIndexForAction(action);
    if (worktreeIndex !== null) hints.worktrees[worktreeIndex] = hintKey(chord.key);
    const tabIndex = tabIndexForAction(action);
    if (tabIndex !== null) hints.tabs[tabIndex] = hintKey(chord.key);
  }
  return hints;
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

/** Numbered navigation actions switch to their in-bounds project, worktree, or tab. */
function handleNavigationIndexAction(
  event: KeyboardEvent,
  action: KeybindingAction,
  current: UseShortcutsOptions,
): void {
  const workspaceIndex = workspaceIndexForAction(action);
  if (workspaceIndex !== null && workspaceIndex <= current.projectCount) {
    event.preventDefault();
    current.onProject(workspaceIndex - 1);
    return;
  }
  const worktreeIndex = worktreeIndexForAction(action);
  if (worktreeIndex !== null && worktreeIndex <= current.worktreeCount) {
    event.preventDefault();
    current.onWorktree(worktreeIndex - 1);
    return;
  }
  const tabIndex = tabIndexForAction(action);
  if (tabIndex !== null && tabIndex <= current.tabCount) {
    event.preventDefault();
    current.onTab(tabIndex - 1);
  }
}
