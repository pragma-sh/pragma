import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { useWorkspace } from "@/state/workspace-context";

/** Inline-rename state for a tab strip (only one tab renames at a time). */
export type TabRenameApi = {
  renamingTabId: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  startRename: (tabId: string, currentTitle: string) => void;
  /** Start a rename from inside an open menu (see the implementation note). */
  startRenameFromMenu: (tabId: string, currentTitle: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
};

/**
 * Shared inline-rename state for tabs. Each strip that can rename — the top bar
 * and every split pane bar — owns its own instance, so the input lives where the
 * tab is shown while the commit path stays in one place.
 */
export function useTabRename(): TabRenameApi {
  const workspace = useWorkspace();
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingTabId]);
  const startRename = useCallback((tabId: string, currentTitle: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentTitle);
  }, []);
  // Radix traps focus inside an open menu, so an input mounted straight from an
  // `onSelect` is pulled back out the instant it focuses itself — the blur then
  // commits the unchanged title and the rename ends before it is visible.
  // Starting on the next macrotask lets the menu finish closing first.
  const startRenameFromMenu = useCallback(
    (tabId: string, currentTitle: string) => {
      setTimeout(() => startRename(tabId, currentTitle), 0);
    },
    [startRename],
  );
  const commitRename = useCallback(() => {
    if (renamingTabId && renameValue.trim()) {
      void workspace.renameTerminalTab(renamingTabId, renameValue.trim());
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue, workspace]);
  const cancelRename = useCallback(() => setRenamingTabId(null), []);
  return {
    renamingTabId,
    renameValue,
    setRenameValue,
    inputRef,
    startRename,
    startRenameFromMenu,
    commitRename,
    cancelRename,
  };
}
