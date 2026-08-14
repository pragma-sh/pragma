import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
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
import { disposeTab, getTabDoc, isTabDirty, setTabDirty } from "@/state/editor-dirty-store";
import { useWorkspace } from "@/state/workspace-context";

type RequestClose = (tab: Tab) => void;
type RequestCloseTabs = (tabs: Tab[]) => void;

interface ConfirmCloseApi {
  requestClose: RequestClose;
  requestCloseTabs: RequestCloseTabs;
}

const ConfirmCloseContext = createContext<ConfirmCloseApi | null>(null);

/** Whether closing this tab has to be confirmed (unsaved edits would be lost). */
function needsConfirm(tab: Tab): boolean {
  return (tab.kind === "editor" || tab.kind === "scratchpad") && isTabDirty(tab.id);
}

/**
 * Provides `requestClose(tab)` / `requestCloseTabs(tabs)` actions that guard
 * closing a **dirty editor tab** behind a Save / Don't save / Cancel dialog.
 * Every other tab (clean editors, terminals, browsers, diffs) closes
 * immediately. Closing a whole pane or split hands over several tabs at once,
 * so the dirty ones queue and the dialog asks about them one by one; Cancel
 * abandons the rest of that batch. The dialog is mounted once here so the top
 * tab strip and the per-pane bars can route through it.
 */
export function ConfirmCloseProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [queue, setQueue] = useState<Tab[]>([]);
  const pending = queue[0] ?? null;

  const closeNow = useCallback(
    (tab: Tab) => {
      disposeTab(tab.id);
      void workspace.closeTab(tab.id);
    },
    [workspace],
  );

  const requestCloseTabs = useCallback<RequestCloseTabs>(
    (tabs) => {
      const dirty: Tab[] = [];
      for (const tab of tabs) {
        if (needsConfirm(tab)) {
          dirty.push(tab);
        } else {
          closeNow(tab);
        }
      }
      if (dirty.length > 0) {
        setQueue((current) => [...current, ...dirty]);
      }
    },
    [closeNow],
  );

  const requestClose = useCallback<RequestClose>(
    (tab) => requestCloseTabs([tab]),
    [requestCloseTabs],
  );

  const api = useMemo(() => ({ requestClose, requestCloseTabs }), [requestClose, requestCloseTabs]);

  const discardAndClose = useCallback(() => {
    const tab = pending;
    setQueue((current) => current.slice(1));
    if (tab) {
      closeNow(tab);
    }
  }, [closeNow, pending]);

  const saveAndClose = useCallback(async () => {
    const tab = pending;
    setQueue((current) => current.slice(1));
    if (!tab?.filePath) {
      return;
    }
    try {
      await writeFile(tab.worktreeId, tab.filePath, getTabDoc(tab.id) ?? "");
      setTabDirty(tab.id, false);
      disposeTab(tab.id);
      await workspace.closeTab(tab.id);
    } catch (cause) {
      // Save failed: keep the tab open and dirty so no edits are lost.
      toast.error(errorMessage(cause));
    }
  }, [pending, workspace]);

  return (
    <ConfirmCloseContext.Provider value={api}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setQueue([])}>
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
            <Button onClick={() => setQueue([])} variant="outline">
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
  return useConfirmCloseApi().requestClose;
}

/** Returns the `requestCloseTabs(tabs)` batch action (close a pane or a split). */
export function useConfirmCloseTabs(): RequestCloseTabs {
  return useConfirmCloseApi().requestCloseTabs;
}

function useConfirmCloseApi(): ConfirmCloseApi {
  const context = useContext(ConfirmCloseContext);
  if (!context) {
    throw new Error("useConfirmClose must be used inside ConfirmCloseProvider");
  }
  return context;
}
