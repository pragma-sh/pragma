import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import type { EditorView as CodeMirrorView } from "@codemirror/view";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import CodeMirror from "@uiw/react-codemirror";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

import {
  useEditorExtensions,
  useEditorFindKeymap,
  useEditorKeymap,
  useEditorLanguage,
} from "@/components/editor/EditorView";
import { MarkdownToolbar } from "@/components/editor/MarkdownToolbar";
import { getMarkdown } from "@/components/editor/tiptap-markdown";
import {
  renderLoadState,
  useEditorFileLoader,
  useEditorOnChange,
  useEditorSave,
  useSaveShortcut,
} from "@/components/editor/use-editor-file";
import { useEditorFind } from "@/components/editor/use-editor-find";
import { markdownFindExtension, useMarkdownFind } from "@/components/editor/use-markdown-find";
import { FindReplaceBar } from "@/components/find-replace/FindReplaceBar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { basename } from "@/lib/path";

const lowlight = createLowlight(common);

/** Markdown extensions that get the WYSIWYG surface (`.mdx` stays in the raw editor — JSX would be mangled). */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown"]);

/** True when the file should open in the markdown preview/editor surface. */
export function isMarkdownPath(filePath: string | null): boolean {
  if (!filePath) return false;
  const name = basename(filePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot !== -1 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1));
}

type MarkdownMode = "editor" | "raw";

/**
 * TipTap WYSIWYG surface whose I/O is GitHub-flavored markdown: `tiptap-markdown`
 * parses/serializes, GFM constructs come from the table kit, task lists, and
 * strikethrough (StarterKit). `doc` seeds the editor and re-seeds it when the
 * file reloads from disk while the surface isn't focused; every edit reports the
 * serialized markdown through `onChange`.
 */
function MarkdownWysiwyg({
  doc,
  modeToggle,
  onChange,
  onSave,
}: {
  doc: string;
  modeToggle: ReactNode;
  onChange: (markdown: string) => void;
  onSave: () => void;
}) {
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  const findRef = useRef<ReturnType<typeof useMarkdownFind>>({
    open: false,
    query: "",
    replaceValue: "",
    ignoreCase: false,
    matchCount: 0,
    currentMatch: 0,
    openBar: () => {},
    closeBar: () => {},
    setQuery: () => {},
    setReplaceValue: () => {},
    setIgnoreCase: () => {},
    findNext: () => {},
    findPrevious: () => {},
    replaceOne: () => {},
    replaceAll: () => {},
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false } }),
      CodeBlockLowlight.configure({ lowlight }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: true, linkify: true }),
      markdownFindExtension,
    ],
    content: doc,
    editorProps: {
      attributes: {
        class:
          "tiptap prose prose-invert prose-sm max-w-3xl min-h-full px-6 py-4 focus:outline-none",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveRef.current();
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          findRef.current.openBar();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChangeRef.current(getMarkdown(instance));
      if (findRef.current.open) {
        findRef.current.setQuery(findRef.current.query);
      }
    },
  });

  const find = useMarkdownFind(editor ?? null);
  findRef.current = find;

  // Re-seed only when the file reloads from disk underneath a blurred editor
  // (live preview of agent edits); comparing serialized markdown avoids
  // clobbering the cursor on the editor's own updates echoing back.
  // `emitUpdate: false` keeps this programmatic re-sync from firing `onUpdate`
  // (which would report a normalized-but-unequal markdown string as an edit
  // and mark the tab dirty, e.g. right after mount when the serializer's
  // round-trip of `doc` doesn't byte-match it).
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (getMarkdown(editor) !== doc) editor.commands.setContent(doc, { emitUpdate: false });
  }, [editor, doc]);

  // Keep the bar (and its mode toggle) up while TipTap is still instantiating.
  if (!editor) return <MarkdownViewBar modeToggle={modeToggle} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MarkdownViewBar modeToggle={modeToggle}>
        <MarkdownToolbar editor={editor} />
      </MarkdownViewBar>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <EditorContent className="h-full" editor={editor} />
        <FindReplaceBar
          currentMatch={find.currentMatch}
          findPlaceholder="Find in file"
          ignoreCase={find.ignoreCase}
          matchCount={find.matchCount}
          onClose={find.closeBar}
          onIgnoreCaseChange={find.setIgnoreCase}
          onNext={find.findNext}
          onPrevious={find.findPrevious}
          onQueryChange={find.setQuery}
          open={find.open}
          query={find.query}
          replace={{
            value: find.replaceValue,
            onValueChange: find.setReplaceValue,
            onReplace: find.replaceOne,
            onReplaceAll: find.replaceAll,
            replaceDisabled: find.matchCount === 0,
          }}
        />
      </div>
    </div>
  );
}

/** The single header bar: formatting shortcuts on the left, mode toggle on the right. */
function MarkdownViewBar({
  children,
  modeToggle,
}: {
  children?: ReactNode;
  modeToggle: ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-elevated px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{children}</div>
      <div className="shrink-0">{modeToggle}</div>
    </div>
  );
}

/** Raw CodeMirror surface sharing the standard editor theme/grammar/save keymap. */
function MarkdownRaw({
  doc,
  filePath,
  onChange,
  save,
}: {
  doc: string;
  filePath: string | null;
  onChange: (value: string) => void;
  save: (contents: string) => Promise<void>;
}) {
  const viewRef = useRef<CodeMirrorView | null>(null);
  const languageExtension = useEditorLanguage(filePath);
  const saveKeymap = useEditorKeymap(save);
  const find = useEditorFind(viewRef);
  const findKeymap = useEditorFindKeymap(find.openBar);
  const extensions = useEditorExtensions(languageExtension, saveKeymap, findKeymap, find.extension);
  return (
    <div className="relative h-full">
      <CodeMirror
        className="h-full"
        extensions={extensions}
        height="100%"
        onChange={(value) => {
          onChange(value);
          if (find.open) {
            find.refreshMatches();
          }
        }}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        theme="none"
        value={doc}
      />
      <FindReplaceBar
        currentMatch={find.currentMatch}
        findPlaceholder="Find in file"
        ignoreCase={find.ignoreCase}
        matchCount={find.matchCount}
        onClose={find.closeBar}
        onIgnoreCaseChange={find.setIgnoreCase}
        onNext={find.findNext}
        onPrevious={find.findPrevious}
        onQueryChange={find.setQuery}
        open={find.open}
        query={find.query}
        replace={{
          value: find.replaceValue,
          onValueChange: find.setReplaceValue,
          onReplace: find.replaceOne,
          onReplaceAll: find.replaceAll,
          replaceDisabled: find.matchCount === 0,
        }}
      />
    </div>
  );
}

/**
 * Markdown preview/editor for `editor` tabs opened on `.md` files. A top-right
 * toggle switches between the WYSIWYG TipTap surface and the raw CodeMirror
 * editor; unsaved edits carry across the switch, and both modes share the same
 * load/dirty/⌘-S-save lifecycle as the plain editor.
 */
export function MarkdownView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath } = tab;
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const [mode, setMode] = useState<MarkdownMode>("editor");
  const { state, load } = useEditorFileLoader(tab, savedDocRef, currentDocRef);
  const save = useEditorSave(tabId, worktreeId, filePath, savedDocRef);
  const onChange = useEditorOnChange(tabId, savedDocRef, currentDocRef);
  const handleSaveShortcut = useSaveShortcut(save, currentDocRef);

  const placeholder = renderLoadState(state, load);
  if (placeholder) return placeholder;

  // The live (possibly unsaved) document survives mode switches: the loader and
  // both surfaces keep `currentDocRef` current, and each surface seeds from it.
  const doc = currentDocRef.current;

  const modeToggle = (
    <Tabs onValueChange={(value) => setMode(value as MarkdownMode)} value={mode}>
      <TabsList className="h-6 p-0.5">
        <TabsTrigger className="px-2 text-xs" value="editor">
          Editor
        </TabsTrigger>
        <TabsTrigger className="px-2 text-xs" value="raw">
          Raw
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas"
      onKeyDown={handleSaveShortcut}
    >
      {mode === "editor" ? (
        <MarkdownWysiwyg
          doc={doc}
          modeToggle={modeToggle}
          onChange={onChange}
          onSave={() => void save(currentDocRef.current)}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <MarkdownViewBar modeToggle={modeToggle} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <MarkdownRaw doc={doc} filePath={filePath} onChange={onChange} save={save} />
          </div>
        </div>
      )}
    </div>
  );
}
