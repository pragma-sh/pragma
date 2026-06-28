import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/errors";

import type { Tab } from "@pragma/constants";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/path";
import { writeFile } from "@/lib/tauri";
import { getTabDoc, isTabDirty, setTabDirty } from "@/state/editor-dirty-store";
import { useWorkspace } from "@/state/workspace-context";

type RequestClose = (tab: Tab) => void;

const ConfirmCloseContext = createContext<RequestClose | null>(null);

/**
 * Provides a `requestClose(tab)` action that guards closing a **dirty editor
 * tab** behind a Save / Don't save / Cancel dialog. Every other tab (clean
 * editors, terminals, browsers, diffs) closes immediately. The dialog is mounted
 * once here so both the top tab strip and the per-pane bars can route through it.
 */
export function ConfirmCloseProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [pending, setPending] = useState<Tab | null>(null);

  const requestClose = useCallback<RequestClose>(
    (tab) => {
      if (tab.kind === "editor" && isTabDirty(tab.id)) {
        setPending(tab);
      } else {
        void workspace.closeTab(tab.id);
      }
    },
    [workspace],
  );

  const discardAndClose = useCallback(() => {
    const tab = pending;
    setPending(null);
    if (tab) {
      void workspace.closeTab(tab.id);
    }
  }, [pending, workspace]);

  const saveAndClose = useCallback(async () => {
    const tab = pending;
    setPending(null);
    if (!tab?.filePath) {
      return;
    }
    try {
      await writeFile(tab.worktreeId, tab.filePath, getTabDoc(tab.id) ?? "");
      setTabDirty(tab.id, false);
      await workspace.closeTab(tab.id);
    } catch (cause) {
      // Save failed: keep the tab open and dirty so no edits are lost.
      toast.error(errorMessage(cause));
    }
  }, [pending, workspace]);

  return (
    <ConfirmCloseContext.Provider value={requestClose}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.filePath ? basename(pending.filePath) : "This file"} has unsaved changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={discardAndClose} variant="ghost">
              Don&apos;t save
            </Button>
            <Button onClick={() => setPending(null)} variant="outline">
              Cancel
            </Button>
            <Button onClick={() => void saveAndClose()}>Save</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmCloseContext.Provider>
  );
}

/** Returns the `requestClose(tab)` action; throws if used outside the provider. */
export function useConfirmClose(): RequestClose {
  const context = useContext(ConfirmCloseContext);
  if (!context) {
    throw new Error("useConfirmClose must be used inside ConfirmCloseProvider");
  }
  return context;
}
