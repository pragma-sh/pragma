import { useCallback, useEffect, useRef, useState } from "react";

import type { ExcalidrawScene, Tab, Whiteboard } from "@pragma/constants";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { toast } from "sonner";

import "@excalidraw/excalidraw/index.css";

import "./whiteboard.css";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { editWhiteboard, getWhiteboard } from "@/lib/tauri";
import { isTabDirty, setTabDirty } from "@/state/editor-dirty-store";
import { useWorkspace } from "@/state/workspace-context";

const SAVE_DEBOUNCE_MS = 700;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; board: Whiteboard }
  | { kind: "error"; message: string };

function initialData(scene: ExcalidrawScene): ExcalidrawInitialDataState {
  return scene as unknown as ExcalidrawInitialDataState;
}

function serializedScene(
  ...args: Parameters<NonNullable<ExcalidrawProps["onChange"]>>
): ExcalidrawScene {
  // Excalidraw's database mode strips files for separate binary storage; Pragma persists one scene.
  return JSON.parse(serializeAsJSON(args[0], args[1], args[2], "local")) as ExcalidrawScene;
}

/**
 * Tracks the root `<html>` theme class (`dark` / light) so the Excalidraw
 * surface follows Pragma's root theme instead of assuming one. The app ships
 * dark-only today, but a root class change (dev experiments, future light
 * mode) must move the canvas with it. The whiteboard CSS maps Excalidraw's
 * color variables onto Pragma's semantic tokens, which already re-resolve per
 * root class — the prop only picks which of Excalidraw's own palettes sits
 * underneath.
 */
function useRootDarkClass(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Editable Excalidraw canvas backed by host-owned optimistic persistence. */
// fallow-ignore-next-line complexity -- controller component composes one canvas's load, dirty, rename, and debounced-save lifecycle; the persistence callbacks are already factored below.
export function WhiteboardView({ tab }: { tab: Tab }) {
  const whiteboardId = tab.whiteboardId;
  const { renameTerminalTab } = useWorkspace();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const boardRef = useRef<Whiteboard | null>(null);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const serializedSceneRef = useRef<string | null>(null);
  const titleRef = useRef(tab.title ?? "");
  const tabTitleRef = useRef(tab.title);
  const externalRenameRef = useRef(false);
  const pendingRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const userInteractedRef = useRef(false);

  // fallow-ignore-next-line complexity -- serial save pipeline must branch on queued edits, unmount, optimistic conflicts, and title synchronization in one atomic callback.
  const flush = useCallback(async () => {
    const board = boardRef.current;
    const scene = sceneRef.current;
    if (!whiteboardId || !board || !scene || !pendingRef.current || savingRef.current) {
      return;
    }
    pendingRef.current = false;
    savingRef.current = true;
    // Dirty state is a module store so it outlives unmount: an unmount-flushed
    // save still clears the tab's dot even though React state is gone.
    setTabDirty(tab.id, true);
    try {
      const saved = await editWhiteboard(
        tab.worktreeId,
        whiteboardId,
        titleRef.current.trim() || board.title,
        scene,
        board.version,
      );
      boardRef.current = saved;
      // The tab dot is the only save indicator, so it must stay up while a
      // newer edit/rename adopted during this save is still queued — clear it
      // only once the pipeline has drained (the queued save then runs from
      // the finally block below).
      if (!pendingRef.current) {
        setTabDirty(tab.id, false);
      }
      // Adopted tab renames queue behind the save that is still carrying the
      // older title; syncing now would clobber the user's newer rename. The
      // latch releases once the save pipeline has drained, so host-normalized
      // titles still propagate when nothing newer is queued.
      if (!pendingRef.current) {
        externalRenameRef.current = false;
      }
      if (saved.title !== tabTitleRef.current && !externalRenameRef.current) {
        tabTitleRef.current = saved.title;
        await renameTerminalTab(tab.id, saved.title);
      }
    } catch (cause) {
      setTabDirty(tab.id, true);
      // A conflicting writer (the SDK, the CLI, another window) advances the
      // stored version, which makes the version we just sent permanently
      // obsolete: every later save would resend it and fail identically, so
      // the canvas could never be saved again. Re-read the head version and
      // queue a retry that carries it — the local scene stays authoritative
      // and is written on top. A failure to even re-read leaves the board as
      // it was, with the tab dirty and Cmd/Ctrl+S still able to retry.
      const stale = boardRef.current;
      let conflict = false;
      try {
        const head = await getWhiteboard(tab.worktreeId, whiteboardId);
        if (stale && head.version !== stale.version) {
          boardRef.current = head;
          pendingRef.current = true;
          conflict = true;
        }
      } catch {
        // Keep the original save error as the reported failure.
      }
      if (conflict) {
        toast.warning("Whiteboard changed elsewhere - re-applying your edits on top.");
      } else {
        toast.error(`Failed to save whiteboard: ${errorMessage(cause)}`);
      }
    } finally {
      savingRef.current = false;
      if (pendingRef.current) {
        if (mountedRef.current) {
          timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
        } else {
          void flush();
        }
      }
    }
  }, [renameTerminalTab, tab.id, tab.worktreeId, whiteboardId]);

  const scheduleSave = useCallback(() => {
    pendingRef.current = true;
    setTabDirty(tab.id, true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush, tab.id]);

  const flushNow = useCallback(() => {
    if (savingRef.current || !isTabDirty(tab.id)) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = true;
    void flush();
  }, [flush, tab.id]);

  const load = useCallback(async () => {
    if (!whiteboardId) {
      setLoadState({ kind: "error", message: "Whiteboard tab is missing its board id." });
      return;
    }
    setLoadState({ kind: "loading" });
    try {
      const board = await getWhiteboard(tab.worktreeId, whiteboardId);
      boardRef.current = board;
      sceneRef.current = board.scene;
      serializedSceneRef.current = JSON.stringify(board.scene);
      userInteractedRef.current = false;
      // A tab rename adopted while the board was still loading wins over the
      // stored title and flushes now; otherwise the stored title is the
      // authoritative initial load and clears the dirty flag. The flush's
      // synchronous prefix already marked the tab dirty, so only the
      // no-adoption path may mark it clean here.
      const adoptedRename = pendingRef.current && titleRef.current !== board.title;
      if (adoptedRename) {
        void flush();
      } else {
        pendingRef.current = false;
        titleRef.current = board.title;
        setTabDirty(tab.id, false);
      }
      setLoadState({ kind: "ready", board });
    } catch (cause) {
      setLoadState({ kind: "error", message: errorMessage(cause) });
    }
  }, [flush, tab.id, tab.worktreeId, whiteboardId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      void flush();
    };
  }, [flush, load]);

  // Adopts renames made through the shared tab strip (double-click / context
  // menu) — the tab itself is the only rename UI: the new title becomes the
  // next optimistic save. tabTitleRef also guards the echo of
  // WhiteboardView's own tab-title sync below — a rename it just pushed never
  // re-fires this effect.
  useEffect(() => {
    const nextTitle = tab.title;
    if (!nextTitle || nextTitle === tabTitleRef.current) {
      return;
    }
    tabTitleRef.current = nextTitle;
    externalRenameRef.current = true;
    titleRef.current = nextTitle;
    scheduleSave();
  }, [scheduleSave, tab.title]);

  const handleChange: NonNullable<ExcalidrawProps["onChange"]> = (...args) => {
    const scene = serializedScene(...args);
    const serialized = JSON.stringify(scene);
    if (serialized === serializedSceneRef.current) return;
    sceneRef.current = scene;
    serializedSceneRef.current = serialized;
    if (!userInteractedRef.current && !pendingRef.current) return;
    scheduleSave();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    userInteractedRef.current = true;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      flushNow();
    }
  };

  const dark = useRootDarkClass();

  if (loadState.kind === "loading") {
    return <Placeholder>Loading whiteboard...</Placeholder>;
  }
  if (loadState.kind === "error") {
    return (
      <Placeholder>
        <p className="text-destructive">{loadState.message}</p>
        <Button className="mt-3" onClick={() => void load()} size="sm" variant="ghost">
          Retry
        </Button>
      </Placeholder>
    );
  }

  return (
    // `pragma-whiteboard` scopes every Excalidraw override in `whiteboard.css`:
    // theme inheritance from Pragma's semantic tokens and the disabled
    // Libraries entry points for this pinned @excalidraw/excalidraw version.
    <div
      className="pragma-whiteboard flex h-full min-h-0 flex-col bg-background"
      onKeyDownCapture={handleKeyDown}
      onPointerDownCapture={() => {
        userInteractedRef.current = true;
      }}
    >
      <div className="min-h-0 flex-1">
        <Excalidraw
          initialData={initialData(loadState.board.scene)}
          onChange={handleChange}
          theme={dark ? "dark" : "light"}
          UIOptions={{ canvasActions: { loadScene: false, toggleTheme: false } }}
        />
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
