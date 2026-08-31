import { type ReactNode, type RefObject, useCallback, useEffect, useState } from "react";

import type { Tab } from "@pragma/constants";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { readFile, writeFile } from "@/lib/tauri";
import {
  getTabDoc,
  getTabSavedDoc,
  isTabDirty,
  setTabDirty,
  setTabDoc,
  setTabSavedDoc,
} from "@/state/editor-dirty-store";

/** Lifecycle of a file-backed editor surface: loading, ready, or a terminal failure. */
export type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

/** What a file-backed editor surface exposes about its on-disk source. */
export interface EditorFileLoader {
  /** Current load lifecycle of the file. */
  state: LoadState;
  /** (Re)reads the file, showing the loading placeholder. Returns a cancel fn. */
  load: () => () => void;
  /**
   * True when the file changed on disk while the tab had unsaved edits, so the
   * change could not be applied automatically.
   */
  externalChange: boolean;
  /** Re-reads the file, discarding unsaved edits. Clears {@link externalChange}. */
  reloadFromDisk: () => void;
}

/** Loads the file into the editor, tracking dirty/doc state, and reloads on external changes. */
export function useEditorFileLoader(
  tab: Tab,
  savedDocRef: RefObject<string>,
  currentDocRef: RefObject<string>,
): EditorFileLoader {
  const { id: tabId, worktreeId, filePath } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [externalChange, setExternalChange] = useState(false);

  const load = useCallback(() => {
    if (!filePath) {
      setState({ kind: "error", message: "This tab has no file path." });
      return () => undefined;
    }
    const preserved = isTabDirty(tabId) ? getTabDoc(tabId) : null;
    if (preserved !== null) {
      savedDocRef.current = getTabSavedDoc(tabId) ?? savedDocRef.current;
      currentDocRef.current = preserved;
      setState({ kind: "ready", doc: preserved });
      return () => undefined;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    setExternalChange(false);
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
        setTabSavedDoc(tabId, contents.text);
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

  /**
   * Re-reads the file **without** dropping back to the loading placeholder, so
   * an external edit lands in place instead of tearing the surface down and
   * remounting it. With `force`, unsaved edits are discarded; without it, a
   * dirty tab keeps the user's work and only raises {@link externalChange}.
   */
  const refresh = useCallback(
    async (force = false) => {
      if (!filePath) return;
      if (!force && isTabDirty(tabId)) {
        setExternalChange(true);
        return;
      }
      try {
        const contents = await readFile(worktreeId, filePath);
        if (contents.truncated || contents.binary) return;
        setExternalChange(false);
        if (contents.text === currentDocRef.current && contents.text === savedDocRef.current) {
          return;
        }
        savedDocRef.current = contents.text;
        currentDocRef.current = contents.text;
        setTabSavedDoc(tabId, contents.text);
        setTabDoc(tabId, contents.text);
        setTabDirty(tabId, false);
        setState((previous) =>
          previous.kind === "ready" ? { kind: "ready", doc: contents.text } : previous,
        );
      } catch {
        // A transient read failure (e.g. an atomic replace mid-flight) must not
        // replace already-good content with an error surface; the next change
        // event or window focus retries.
      }
    },
    [tabId, worktreeId, filePath, savedDocRef, currentDocRef],
  );

  useEffect(() => load(), [load]);

  // Live preview: when the server's worktree watcher reports the open file
  // changed on disk (e.g. an agent edits it), re-read it in place — unless the
  // user has unsaved edits, in which case their in-progress work must not be
  // clobbered and the change is surfaced as a reload affordance instead.
  useWorktreeFileChange(worktreeId, (change) => {
    if (change.path === filePath) void refresh();
  });

  // Belt to the watcher's braces: re-read when the window regains focus. The
  // watcher is a live subscription that can be missed (the socket dropped, the
  // machine slept, the change landed while the tab was unmounted), and a stale
  // buffer that only a tab close fixes is worse than one extra read.
  useEffect(() => {
    if (!filePath) return;
    const revalidate = (): void => {
      if (globalThis.document.visibilityState === "visible") void refresh();
    };
    globalThis.addEventListener("focus", revalidate);
    globalThis.document.addEventListener("visibilitychange", revalidate);
    return () => {
      globalThis.removeEventListener("focus", revalidate);
      globalThis.document.removeEventListener("visibilitychange", revalidate);
    };
  }, [filePath, refresh]);

  const reloadFromDisk = useCallback(() => void refresh(true), [refresh]);

  return { state, load, externalChange, reloadFromDisk };
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
        setTabSavedDoc(tabId, contents);
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
