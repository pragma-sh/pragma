import { type ReactNode, type RefObject, useCallback, useEffect, useState } from "react";

import type { Tab } from "@pragma/constants";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { readFile, writeFile } from "@/lib/tauri";
import { disposeTab, isTabDirty, setTabDirty, setTabDoc } from "@/state/editor-dirty-store";

/** Lifecycle of a file-backed editor surface: loading, ready, or a terminal failure. */
export type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

/** Loads the file into the editor, tracking dirty/doc state, and reloads on external changes. */
export function useEditorFileLoader(
  tab: Tab,
  savedDocRef: RefObject<string>,
  currentDocRef: RefObject<string>,
): { state: LoadState; load: () => () => void } {
  const { id: tabId, worktreeId, filePath } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(() => {
    if (!filePath) {
      setState({ kind: "error", message: "This tab has no file path." });
      return () => undefined;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const contents = await readFile(worktreeId, filePath);
        if (cancelled) return;
        if (contents.truncated) {
          setState({ kind: "unsupported", reason: "This file is too large to edit." });
          return;
        }
        if (contents.binary) {
          setState({ kind: "unsupported", reason: "This file is binary and can't be shown." });
          return;
        }
        savedDocRef.current = contents.text;
        currentDocRef.current = contents.text;
        setTabDoc(tabId, contents.text);
        setTabDirty(tabId, false);
        setState({ kind: "ready", doc: contents.text });
      } catch (cause) {
        if (!cancelled) setState({ kind: "error", message: errorMessage(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, worktreeId, filePath, savedDocRef, currentDocRef]);

  useEffect(() => load(), [load]);

  // Live preview: when the server's worktree watcher reports the open file
  // changed on disk (e.g. an agent edits it), reload it — unless the user has
  // unsaved edits, in which case their in-progress work must not be clobbered.
  useWorktreeFileChange(worktreeId, (change) => {
    if (change.path === filePath && !isTabDirty(tabId)) load();
  });

  // Drop transient dirty/doc state when the tab's editor unmounts.
  useEffect(() => () => disposeTab(tabId), [tabId]);

  return { state, load };
}

/** Save the editor contents to disk on demand, updating dirty/doc state. */
export function useEditorSave(
  tabId: string,
  worktreeId: string,
  filePath: string | null,
  savedDocRef: RefObject<string>,
): (contents: string) => Promise<void> {
  return useCallback(
    async (contents: string) => {
      if (!filePath) return;
      try {
        await writeFile(worktreeId, filePath, contents);
        savedDocRef.current = contents;
        setTabDoc(tabId, contents);
        setTabDirty(tabId, false);
        toast.success("Saved");
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [tabId, worktreeId, filePath, savedDocRef],
  );
}

/** Track the live document value and mark the tab dirty against the saved snapshot. */
export function useEditorOnChange(
  tabId: string,
  savedDocRef: RefObject<string>,
  currentDocRef: RefObject<string>,
): (value: string) => void {
  return useCallback(
    (value: string) => {
      currentDocRef.current = value;
      setTabDoc(tabId, value);
      setTabDirty(tabId, value !== savedDocRef.current);
    },
    [tabId, savedDocRef, currentDocRef],
  );
}

/** Relay ⌘/Ctrl-S to save when the surface's own keymap can't run (e.g. test stub). */
export function useSaveShortcut(
  save: (contents: string) => Promise<void>,
  currentDocRef: RefObject<string>,
): (event: React.KeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        void save(currentDocRef.current);
      }
    },
    [save, currentDocRef],
  );
}

/** Render the loading/unsupported/error placeholder, or null when the doc is ready. */
export function renderLoadState(state: LoadState, load: () => () => void): ReactNode {
  if (state.kind === "loading") return <EditorPlaceholder>Loading…</EditorPlaceholder>;
  if (state.kind === "unsupported") return <EditorPlaceholder>{state.reason}</EditorPlaceholder>;
  if (state.kind === "error") {
    return (
      <EditorPlaceholder>
        <p className="text-destructive">{state.message}</p>
        <Button className="mt-3" onClick={load} size="sm" variant="ghost">
          Retry
        </Button>
      </EditorPlaceholder>
    );
  }
  return null;
}

/** Centered muted placeholder shown while a file-backed tab isn't ready. */
function EditorPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
