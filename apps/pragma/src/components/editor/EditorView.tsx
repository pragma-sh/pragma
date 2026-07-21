import { useEffect, useMemo, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView as CodeMirrorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";
import {
  renderLoadState,
  useEditorFileLoader,
  useEditorOnChange,
  useEditorSave,
  useSaveShortcut,
} from "@/components/editor/use-editor-file";
import { useEditorFind } from "@/components/editor/use-editor-find";
import { EditorFindReplaceBar } from "@/components/find-replace/EditorFindReplaceBar";
import { clearEditorLocation, useEditorLocation } from "@/state/editor-location-store";

/** Resolve a language grammar lazily by filename; plain text on no match. */
export function useEditorLanguage(filePath: string | null): Extension | null {
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

/** The ⌘/Ctrl-S keymap extension that triggers a save from inside CodeMirror. */
export function useEditorKeymap(save: (contents: string) => Promise<void>): Extension {
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

/** The ⌘/Ctrl-F keymap extension that opens the find/replace bar. */
export function useEditorFindKeymap(openFindBar: () => void): Extension {
  return useMemo(
    () =>
      Prec.high(
        keymap.of([
          {
            key: "Mod-f",
            preventDefault: true,
            run: () => {
              openFindBar();
              return true;
            },
          },
        ]),
      ),
    [openFindBar],
  );
}

/** The full CodeMirror extension set (theme + save/find keymaps + search state + resolved language). */
export function useEditorExtensions(
  languageExtension: Extension | null,
  saveKeymap: Extension,
  findKeymap: Extension,
  findExtension: Extension,
): Extension[] {
  return useMemo(() => {
    const base = [
      pragmaEditorTheme,
      pragmaSyntaxHighlighting,
      saveKeymap,
      findKeymap,
      findExtension,
    ];
    return languageExtension ? [...base, languageExtension] : base;
  }, [saveKeymap, findKeymap, findExtension, languageExtension]);
}

/**
 * CodeMirror 6 editor for `editor` tabs. Reads the file on mount (keyed on the
 * tab id), tracks dirty state, and saves on ⌘/Ctrl-S only — there is no
 * autosave. Binary/oversized files render a placeholder instead of garbage.
 */
// fallow-ignore-next-line complexity -- wires together file load/save/language/keymap/find hooks for one CodeMirror instance; each hook already owns its own logic, this just composes them.
export function EditorView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath } = tab;
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const viewRef = useRef<CodeMirrorView | null>(null);
  const location = useEditorLocation(tabId);
  const { state, load } = useEditorFileLoader(tab, savedDocRef, currentDocRef);
  const languageExtension = useEditorLanguage(filePath);
  const save = useEditorSave(tabId, worktreeId, filePath, savedDocRef);
  const baseOnChange = useEditorOnChange(tabId, savedDocRef, currentDocRef);
  const saveKeymap = useEditorKeymap(save);
  const find = useEditorFind(viewRef);
  const findKeymap = useEditorFindKeymap(find.openBar);
  const extensions = useEditorExtensions(languageExtension, saveKeymap, findKeymap, find.extension);
  const handleSaveShortcut = useSaveShortcut(save, currentDocRef);
  const onChange = (value: string) => {
    baseOnChange(value);
    if (find.open) {
      find.refreshMatches();
    }
  };

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
    <div
      className="relative h-full min-h-0 overflow-hidden bg-canvas"
      onKeyDown={handleSaveShortcut}
    >
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
      <EditorFindReplaceBar find={find} />
    </div>
  );
}
