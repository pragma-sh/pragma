import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Tab } from "@pragma/constants";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView as CodeMirrorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { toast } from "sonner";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { readFile, writeFile } from "@/lib/tauri";
import { disposeTab, isTabDirty, setTabDirty, setTabDoc } from "@/state/editor-dirty-store";
import { clearEditorLocation, useEditorLocation } from "@/state/editor-location-store";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

/** Loads the file into the editor, tracking dirty/doc state, and reloads on external changes. */
function useEditorFileLoader(
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

/** Resolve a language grammar lazily by filename; plain text on no match. */
function useEditorLanguage(filePath: string | null): Extension | null {
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(null);
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setLanguageExtension(null);
    void (async () => {
      const extension = await loadLanguageExtension(filePath);
      if (!cancelled) setLanguageExtension(extension);
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  return languageExtension;
}

/** Save the editor contents to disk on demand, updating dirty/doc state. */
function useEditorSave(
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
function useEditorOnChange(
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

/** The ⌘/Ctrl-S keymap extension that triggers a save from inside CodeMirror. */
function useEditorKeymap(save: (contents: string) => Promise<void>): Extension {
  return useMemo(
    () =>
      Prec.high(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: (view) => {
              void save(view.state.doc.toString());
              return true;
            },
          },
        ]),
      ),
    [save],
  );
}

/** The full CodeMirror extension set (theme + save keymap + resolved language). */
function useEditorExtensions(
  languageExtension: Extension | null,
  saveKeymap: Extension,
): Extension[] {
  return useMemo(() => {
    const base = [pragmaEditorTheme, pragmaSyntaxHighlighting, saveKeymap];
    return languageExtension ? [...base, languageExtension] : base;
  }, [saveKeymap, languageExtension]);
}

/** Relay ⌘/Ctrl-S to save when the CodeMirror keymap can't run (e.g. test stub). */
function useSaveShortcut(
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
function renderLoadState(state: LoadState, load: () => () => void): ReactNode {
  if (state.kind === "loading") return <Placeholder>Loading…</Placeholder>;
  if (state.kind === "unsupported") return <Placeholder>{state.reason}</Placeholder>;
  if (state.kind === "error") {
    return (
      <Placeholder>
        <p className="text-destructive">{state.message}</p>
        <Button className="mt-3" onClick={load} size="sm" variant="ghost">
          Retry
        </Button>
      </Placeholder>
    );
  }
  return null;
}

/**
 * CodeMirror 6 editor for `editor` tabs. Reads the file on mount (keyed on the
 * tab id), tracks dirty state, and saves on ⌘/Ctrl-S only — there is no
 * autosave. Binary/oversized files render a placeholder instead of garbage.
 */
export function EditorView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath } = tab;
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const viewRef = useRef<CodeMirrorView | null>(null);
  const location = useEditorLocation(tabId);
  const { state, load } = useEditorFileLoader(tab, savedDocRef, currentDocRef);
  const languageExtension = useEditorLanguage(filePath);
  const save = useEditorSave(tabId, worktreeId, filePath, savedDocRef);
  const onChange = useEditorOnChange(tabId, savedDocRef, currentDocRef);
  const saveKeymap = useEditorKeymap(save);
  const extensions = useEditorExtensions(languageExtension, saveKeymap);
  const handleSaveShortcut = useSaveShortcut(save, currentDocRef);

  useEffect(() => {
    const view = viewRef.current;
    if (state.kind !== "ready" || !view || !location) return;
    const lineNumber = Math.min(location.line, view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const anchor = Math.min(line.to, line.from + location.column - 1);
    view.dispatch({
      selection: { anchor },
      effects: CodeMirrorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
    clearEditorLocation(tabId, location.generation);
  }, [location, state, tabId]);

  const placeholder = renderLoadState(state, load);
  if (placeholder) return placeholder;

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only
    <div className="h-full min-h-0 overflow-hidden bg-canvas" onKeyDown={handleSaveShortcut}>
      <CodeMirror
        className="h-full"
        extensions={extensions}
        height="100%"
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        theme="none"
        value={state.kind === "ready" ? state.doc : ""}
      />
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
