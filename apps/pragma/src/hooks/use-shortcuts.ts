import { useEffect, useRef, useState } from "react";

import type { KeybindingPlatform, KeybindingAction } from "@/lib/keybindings";
import { actionForEvent, workspaceIndexForAction } from "@/lib/keybindings";
import { getPlatform, loadKeybindings } from "@/lib/tauri";

interface UseShortcutsOptions {
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
}

interface ShortcutState {
  platform: KeybindingPlatform;
  actionForEvent: (event: KeyboardEvent) => KeybindingAction | null;
}

/** Registers window-level keyboard shortcuts driven by `~/.pragma/keybindings.json`. */
export function useShortcuts(options: UseShortcutsOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [shortcutState, setShortcutState] = useState<ShortcutState | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [platform, config] = await Promise.all([getPlatform(), loadKeybindings()]);
      if (cancelled) {
        return;
      }
      setShortcutState({
        platform,
        actionForEvent: (event) => actionForEvent(event, config, platform),
      });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!shortcutState) {
      return;
    }
    const state = shortcutState;

    function onKeyDown(event: KeyboardEvent) {
      const action = state.actionForEvent(event);
      if (!action) {
        return;
      }

      const current = optionsRef.current;
      switch (action) {
        case "nextTab":
          event.preventDefault();
          current.onNextTab();
          break;
        case "previousTab":
          event.preventDefault();
          current.onPreviousTab();
          break;
        case "closeTopTab":
          event.preventDefault();
          current.onCloseTopTab();
          break;
        case "newTerminalTab":
          event.preventDefault();
          current.onNewTerminalTab();
          break;
        case "newBrowserTab":
          event.preventDefault();
          current.onNewBrowserTab();
          break;
        case "clearTerminal":
          event.preventDefault();
          current.onClearTerminal();
          break;
        case "browserReload":
          event.preventDefault();
          current.onBrowserReload();
          break;
        case "browserDevtools":
          event.preventDefault();
          current.onBrowserDevtools();
          break;
        case "browserCopyUrl":
          event.preventDefault();
          current.onBrowserCopyUrl();
          break;
        default: {
          const workspaceIndex = workspaceIndexForAction(action);
          if (workspaceIndex !== null && workspaceIndex <= current.projectCount) {
            event.preventDefault();
            current.onProject(workspaceIndex - 1);
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutState]);
}
