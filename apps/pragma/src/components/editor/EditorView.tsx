import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { toast } from "sonner";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";
import { Button } from "@/components/ui/button";
import { readFile, writeFile } from "@/lib/tauri";
import { disposeTab, setTabDirty, setTabDoc } from "@/state/editor-dirty-store";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * CodeMirror 6 editor for `editor` tabs. Reads the file on mount (keyed on the
 * tab id), tracks dirty state, and saves on ⌘/Ctrl-S only — there is no
 * autosave. Binary/oversized files render a placeholder instead of garbage.
 */
export function EditorView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(null);
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");

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
        if (cancelled) {
          return;
        }
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
        if (!cancelled) {
          setState({ kind: "error", message: messageFor(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, worktreeId, filePath]);

  useEffect(() => load(), [load]);

  // Resolve a language grammar lazily by filename; plain text on no match.
  useEffect(() => {
    if (!filePath) {
      return;
    }
    let cancelled = false;
    setLanguageExtension(null);
    void (async () => {
      const extension = await loadLanguageExtension(filePath);
      if (!cancelled) {
        setLanguageExtension(extension);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, filePath]);

  // Drop transient dirty/doc state when the tab's editor unmounts.
  useEffect(() => () => disposeTab(tabId), [tabId]);

  const save = useCallback(
    async (contents: string) => {
      if (!filePath) {
        return;
      }
      try {
        await writeFile(worktreeId, filePath, contents);
        savedDocRef.current = contents;
        setTabDoc(tabId, contents);
        setTabDirty(tabId, false);
        toast.success("Saved");
      } catch (cause) {
        toast.error(messageFor(cause));
      }
    },
    [tabId, worktreeId, filePath],
  );

  const onChange = useCallback(
    (value: string) => {
      currentDocRef.current = value;
      setTabDoc(tabId, value);
      setTabDirty(tabId, value !== savedDocRef.current);
    },
    [tabId],
  );

  const saveKeymap = useMemo(
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

  const extensions = useMemo(() => {
    const base = [pragmaEditorTheme, pragmaSyntaxHighlighting, saveKeymap];
    return languageExtension ? [...base, languageExtension] : base;
  }, [saveKeymap, languageExtension]);

  if (state.kind === "loading") {
    return <Placeholder>Loading…</Placeholder>;
  }
  if (state.kind === "unsupported") {
    return <Placeholder>{state.reason}</Placeholder>;
  }
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

  return (
    // Fallback save path for environments where the CM keymap can't run (e.g.
    // the textarea-backed test stub). In the real editor the CM keymap fires
    // first and calls preventDefault, so this no-ops. The CodeMirror surface is
    // the real interactive element; this wrapper only relays the shortcut.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only
    <div
      className="h-full min-h-0 overflow-hidden bg-[#0b0d10]"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          if (event.defaultPrevented) {
            return;
          }
          event.preventDefault();
          void save(currentDocRef.current);
        }
      }}
    >
      <CodeMirror
        className="h-full"
        extensions={extensions}
        height="100%"
        onChange={onChange}
        theme="none"
        value={state.doc}
      />
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-[#0b0d10] p-6 text-center text-sm text-slate-400">
      {children}
    </div>
  );
}
