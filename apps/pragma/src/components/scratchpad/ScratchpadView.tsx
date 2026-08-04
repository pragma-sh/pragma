import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { MessageSquarePlus, MessagesSquare, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { type MarkdownInlineEditRequest, MarkdownRaw } from "@/components/editor/MarkdownView";
import { MarkdownToolbar } from "@/components/editor/MarkdownToolbar";
import { getMarkdown } from "@/components/editor/tiptap-markdown";
import {
  renderLoadState,
  useEditorFileLoader,
  useEditorOnChange,
  useEditorSave,
  useSaveShortcut,
} from "@/components/editor/use-editor-file";
import {
  attachScratchpadAgent,
  parseScratchpadDocument,
  replaceScratchpadBody,
  scratchpadCommentsPath,
  type ScratchpadDocument,
} from "@/components/scratchpad/scratchpad-document";
import {
  clearScratchpadPickerTarget,
  parseScratchpadComments,
  scratchpadCommentDecorations,
  ScratchpadCommentPickerExtension,
  ScratchpadCommentsExtension,
  type ScratchpadComment,
  type ScratchpadRange,
  setScratchpadCommentDecorations,
  setScratchpadPickerActive,
} from "@/components/scratchpad/scratchpad-comments";
import {
  MdxJsxContainer,
  MdxRenderedBlock,
  preprocessMdxForTiptap,
} from "@/components/scratchpad/mdx-hybrid";
import { scratchpadMarkdownExtensions } from "@/components/scratchpad/scratchpad-extensions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage } from "@/lib/errors";
import { pathExists, readFile, scratchpadPromptAgent, writeFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

const commentDrafts = new Map<string, ScratchpadComment[]>();
const commentWriteQueues = new Map<string, Promise<void>>();
type ScratchpadMode = "editor" | "raw";

interface ScratchpadWysiwygProps {
  body: string;
  comments: readonly ScratchpadComment[];
  commentsEnabled: boolean;
  filePath: string;
  getAttachedAgentTabId: () => string | null;
  modeToggle: ReactNode;
  onBodyChange: (body: string) => void;
  onCommentsChange: (comments: ScratchpadComment[]) => void;
  onInlineEdit: (request: MarkdownInlineEditRequest) => void;
  onRequestAgentAttachment: () => Promise<boolean>;
  onSave: () => void;
  worktreeId: string;
}

function ScratchpadWysiwyg({
  body,
  comments,
  commentsEnabled,
  filePath,
  getAttachedAgentTabId,
  modeToggle,
  onBodyChange,
  onCommentsChange,
  onInlineEdit,
  onRequestAgentAttachment,
  onSave,
  worktreeId,
}: ScratchpadWysiwygProps) {
  const [commentMode, setCommentMode] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [hover, setHover] = useState<PickBox | null>(null);
  const [target, setTarget] = useState<PickBox | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onHoverRef = useRef<(range: ScratchpadRange | null) => void>(() => undefined);
  const onPickRef = useRef<(range: ScratchpadRange | null) => void>(() => undefined);
  const appliedBodyRef = useRef(body);
  const onBodyChangeRef = useRef(onBodyChange);
  const onCommentsChangeRef = useRef(onCommentsChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onBodyChangeRef.current = onBodyChange;
    onCommentsChangeRef.current = onCommentsChange;
    onSaveRef.current = onSave;
  }, [onBodyChange, onCommentsChange, onSave]);

  let prepared = "";
  let parseError: string | null = null;
  try {
    prepared = preprocessMdxForTiptap(body);
  } catch (cause) {
    parseError = errorMessage(cause);
  }
  const editor = useEditor({
    extensions: [
      ...scratchpadMarkdownExtensions(),
      MdxJsxContainer,
      MdxRenderedBlock.configure({
        filePath,
        getAttachedAgentTabId,
        onRequestAgentAttachment,
        worktreeId,
      }),
      ScratchpadCommentsExtension,
      ScratchpadCommentPickerExtension.configure({
        onHover: (range) => onHoverRef.current(range),
        onPick: (range) => onPickRef.current(range),
      }),
    ],
    content: prepared,
    editorProps: {
      attributes: {
        class:
          "tiptap prose prose-invert prose-sm max-w-3xl min-h-full px-6 py-4 focus:outline-none",
      },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          const { from, to } = view.state.selection;
          const selectedText = view.state.doc.textBetween(from, to, "\n");
          const before = view.state.doc.textBetween(0, from, "\n");
          onInlineEdit({
            selectedText,
            occurrence: selectedText ? before.split(selectedText).length - 1 : 0,
          });
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => {
      const next = getMarkdown(instance);
      appliedBodyRef.current = next;
      onBodyChangeRef.current(next);
    },
    onTransaction: ({ editor: instance, transaction }) => {
      if (transaction.docChanged) {
        onCommentsChangeRef.current(scratchpadCommentDecorations(instance));
      }
    },
  });

  useEffect(() => {
    if (editor) setScratchpadCommentDecorations(editor, comments);
  }, [editor, comments]);

  useEffect(() => {
    if (!editor) return;
    onHoverRef.current = (range) => setHover(measurePick(editor, scrollRef.current, range));
    onPickRef.current = (range) => {
      setCommentText("");
      setTarget(measurePick(editor, scrollRef.current, range));
    };
  }, [editor]);

  // The picker owns the surface while comment mode is on: no edits, no caret.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!commentMode);
    setScratchpadPickerActive(editor, commentMode);
    setHover(null);
    setTarget(null);
    setCommentText("");
    return () => {
      editor.setEditable(true);
    };
  }, [editor, commentMode]);

  // Push a new body into the editor whenever it comes from outside this editor
  // — an agent rewriting the file, a reload from disk, a Raw-mode edit. Keyed on
  // the body we last applied rather than on `getMarkdown(editor)`, because the
  // TipTap round-trip renormalizes MDX and so never compares equal, which would
  // otherwise re-set the content on every render and remount every rendered MDX
  // block. Focus is not a reason to skip: dropping the update there is what left
  // the surface stale until the tab was closed and reopened.
  useEffect(() => {
    if (!editor || parseError || appliedBodyRef.current === body) return;
    appliedBodyRef.current = body;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(prepared, { emitUpdate: false });
    if (!editor.isFocused) return;
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
  }, [editor, body, parseError, prepared]);

  if (!editor) return <ScratchpadBar modeToggle={modeToggle} />;
  if (parseError) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ScratchpadBar modeToggle={modeToggle} />
        <div className="grid flex-1 place-items-center p-6 text-sm text-destructive">
          Invalid MDX: {parseError}. Use Raw mode to fix source.
        </div>
      </div>
    );
  }
  const addComment = (): void => {
    const text = commentText.trim();
    if (!text || !target) return;
    onCommentsChange([
      ...comments,
      {
        id: crypto.randomUUID(),
        from: target.from,
        to: target.to,
        quote: rangeQuote(editor, target),
        text,
        createdAt: Date.now(),
        resolvedAt: null,
      },
    ]);
    setCommentText("");
    setTarget(null);
    clearScratchpadPickerTarget(editor);
  };

  const dismissTarget = (): void => {
    setCommentText("");
    setTarget(null);
    clearScratchpadPickerTarget(editor);
  };

  // One box at a time, like the browser overlay: the picked block wins over hover.
  const highlight = target ?? hover;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScratchpadBar modeToggle={modeToggle}>
        <MarkdownToolbar editor={editor}>
          <Button
            aria-pressed={commentMode}
            className={cn("h-6 gap-1 px-2 text-xs font-medium", commentMode && "shadow-sm")}
            disabled={!commentsEnabled}
            onClick={() => setCommentMode((active) => !active)}
            size="sm"
            title="Click any block to comment on it"
            variant={commentMode ? "default" : "secondary"}
          >
            <MessageSquarePlus className="size-3.5" />
            {commentMode ? "Done commenting" : "Comment"}
          </Button>
        </MarkdownToolbar>
      </ScratchpadBar>
      <div className="relative min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <EditorContent className="h-full" editor={editor} />
        {commentMode ? <PickHighlight box={highlight} selected={target !== null} /> : null}
        {commentMode && target ? (
          <CommentPill
            box={target}
            container={scrollRef.current}
            onCancel={dismissTarget}
            onChange={setCommentText}
            onSubmit={addComment}
            value={commentText}
          />
        ) : null}
      </div>
    </div>
  );
}

/** A picked block plus its rect inside the scroll container's content box. */
interface PickBox extends ScratchpadRange {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Rough pill height, used to flip it above a block near the viewport floor. */
const PILL_HEIGHT = 38;
/** Gap between the picked block and the label/pill, matching the browser overlay. */
const PILL_GAP = 8;

/**
 * The picker overlay: a ring-bordered box with its own tint layer, painted like
 * the in-app browser's design mode (`DESIGN_SCRIPT` in
 * `src-tauri/src/browser.rs`) minus its tag label. The box stays mounted for
 * the whole session so moving between blocks glides instead of re-mounting; it
 * lives in the scroll container's content box, so it tracks the block while the
 * surface scrolls without re-measuring.
 */
function PickHighlight({ box, selected }: { box: PickBox | null; selected: boolean }) {
  return (
    <div
      className="scratchpad-design-box"
      data-selected={selected}
      data-visible={box !== null}
      style={{
        transform: `translate(${box?.left ?? 0}px,${box?.top ?? 0}px)`,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
      }}
    >
      <div className="scratchpad-design-fill" />
    </div>
  );
}

/**
 * The comment pill: same rounded input plus circular "+" action the browser
 * design mode stages changes with, docked under the picked block and flipped
 * above it when the block sits near the bottom of the surface.
 */
function CommentPill({
  box,
  container,
  onCancel,
  onChange,
  onSubmit,
  value,
}: {
  box: PickBox;
  container: HTMLElement | null;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const below = box.top + box.height + PILL_GAP;
  const floor = (container?.scrollTop ?? 0) + (container?.clientHeight ?? 0);
  const top =
    below + PILL_HEIGHT + PILL_GAP <= floor ? below : Math.max(0, box.top - PILL_HEIGHT - PILL_GAP);
  const left = Math.max(8, Math.min(box.left, (container?.clientWidth ?? box.left) - 340));
  return (
    <form
      className="scratchpad-design-pill"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      style={{ transform: `translate(${left}px,${top}px)` }}
    >
      <input
        aria-label="Comment on this block"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Describe the change"
        ref={inputRef}
        type="text"
        value={value}
      />
      <button aria-label="Add comment" disabled={!value.trim()} type="submit">
        +
      </button>
    </form>
  );
}

/**
 * What the agent is shown as the commented-on thing. A JSX block is an atom
 * with no text, so it quotes its MDX source instead of coming back empty.
 */
function rangeQuote(editor: Editor, range: ScratchpadRange): string {
  const text = editor.state.doc.textBetween(range.from, range.to, "\n").trim();
  if (text) return text;
  const raw: unknown = editor.state.doc.nodeAt(range.from)?.attrs.raw;
  return typeof raw === "string" ? raw : "";
}

/** Measures a picked range against the scroll container's content box. */
function measurePick(
  editor: Editor,
  container: HTMLElement | null,
  range: ScratchpadRange | null,
): PickBox | null {
  if (!container || !range) return null;
  const dom = editor.view.nodeDOM(range.from);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  return {
    ...range,
    top: rect.top - bounds.top + container.scrollTop,
    left: rect.left - bounds.left + container.scrollLeft,
    width: rect.width,
    height: rect.height,
  };
}

function ScratchpadBar({ children, modeToggle }: { children?: ReactNode; modeToggle: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-elevated px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{children}</div>
      <div className="shrink-0">{modeToggle}</div>
    </div>
  );
}

/** Managed, interactive MDX scratchpad tab. */
export function ScratchpadView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath } = tab;
  const workspace = useWorkspace();
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const documentRef = useRef<ScratchpadDocument | null>(null);
  const attachedTabRef = useRef<string | null>(null);
  const attachResolverRef = useRef<((attached: boolean) => void) | null>(null);
  const commentsDirtyRef = useRef(false);
  const commentsRef = useRef<ScratchpadComment[]>([]);
  const [mode, setMode] = useState<ScratchpadMode>("editor");
  const [, setRevision] = useState(0);
  const [comments, setComments] = useState<ScratchpadComment[]>([]);
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [inlineEditRequest, setInlineEditRequest] = useState<MarkdownInlineEditRequest | null>(
    null,
  );
  const { state, load, externalChange, reloadFromDisk } = useEditorFileLoader(
    tab,
    savedDocRef,
    currentDocRef,
    { preserveOnUnmount: true },
  );
  const save = useEditorSave(tabId, worktreeId, filePath, savedDocRef);
  const onChange = useEditorOnChange(tabId, savedDocRef, currentDocRef);
  const handleSaveShortcut = useSaveShortcut(save, currentDocRef);
  const isRemote = workspace.remoteWorktrees[worktreeId] === true;

  let document: ScratchpadDocument | null = null;
  let documentError: string | null = null;
  if (state.kind === "ready") {
    try {
      document = parseScratchpadDocument(currentDocRef.current);
      documentRef.current = document;
      attachedTabRef.current = document.metadata.agentTabId;
    } catch (cause) {
      documentError = errorMessage(cause);
    }
  }

  useEffect(() => {
    if (!filePath || state.kind !== "ready") return;
    let current = true;
    const commentsPath = scratchpadCommentsPath(filePath);
    const draftKey = `${worktreeId}:${commentsPath}`;
    const draft = commentDrafts.get(draftKey);
    setCommentsLoaded(false);
    if (draft) {
      commentsRef.current = draft;
      setComments(draft);
      setCommentsLoaded(true);
      return () => {
        current = false;
      };
    }
    void (async () => {
      try {
        const exists = await pathExists(worktreeId, commentsPath);
        if (!current) return;
        if (!exists) {
          commentsRef.current = [];
          setComments([]);
          setCommentsLoaded(true);
          return;
        }
        const file = await readFile(worktreeId, commentsPath);
        if (!current) return;
        const parsed = parseScratchpadComments(file.text);
        commentsRef.current = parsed;
        setComments(parsed);
        setCommentsLoaded(true);
      } catch (cause) {
        if (current) {
          commentsRef.current = [];
          setComments([]);
          setCommentsLoaded(true);
          toast.error(`Comments: ${errorMessage(cause)}`);
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [filePath, state.kind, worktreeId]);

  useEffect(() => {
    if (!filePath || !commentsLoaded || !commentsDirtyRef.current) return;
    const timeout = setTimeout(() => {
      void writeScratchpadComments(worktreeId, filePath, comments)
        .then(() => {
          if (commentsRef.current === comments) {
            commentsDirtyRef.current = false;
            commentDrafts.delete(`${worktreeId}:${scratchpadCommentsPath(filePath)}`);
          }
          return undefined;
        })
        .catch((cause: unknown) => toast.error(`Comments: ${errorMessage(cause)}`));
    }, 250);
    return () => clearTimeout(timeout);
  }, [comments, commentsLoaded, filePath, worktreeId]);

  const updateComments = (next: ScratchpadComment[]): void => {
    const meaningful = commentsMeaningfullyChanged(commentsRef.current, next);
    commentsDirtyRef.current = true;
    commentsRef.current = next;
    if (filePath) {
      const key = `${worktreeId}:${scratchpadCommentsPath(filePath)}`;
      commentDrafts.set(key, next);
      if (meaningful) {
        void writeScratchpadComments(worktreeId, filePath, next)
          .then(() => {
            if (commentsRef.current === next) {
              commentsDirtyRef.current = false;
              commentDrafts.delete(key);
            }
            return undefined;
          })
          .catch((cause: unknown) => toast.error(`Comments: ${errorMessage(cause)}`));
      }
    }
    setComments(next);
  };

  const updateBody = (body: string): void => {
    const current = documentRef.current;
    if (!current) return;
    onChange(replaceScratchpadBody(current, body));
  };

  const saveBody = (body: string): Promise<void> => {
    const current = documentRef.current;
    return save(current ? replaceScratchpadBody(current, body) : currentDocRef.current);
  };

  const requestAgentAttachment = (): Promise<boolean> => {
    setAttachOpen(true);
    return new Promise((resolve) => {
      attachResolverRef.current?.(false);
      attachResolverRef.current = resolve;
    });
  };

  const closeAttachment = (attached: boolean): void => {
    setAttachOpen(false);
    attachResolverRef.current?.(attached);
    attachResolverRef.current = null;
  };

  const attachAgent = async (agentTab: Tab): Promise<void> => {
    if (!agentTab.agentId) return;
    const next = attachScratchpadAgent(currentDocRef.current, {
      tabId: agentTab.id,
      agentId: agentTab.agentId,
    });
    onChange(next);
    documentRef.current = parseScratchpadDocument(next);
    attachedTabRef.current = agentTab.id;
    setRevision((value) => value + 1);
    await save(next);
    closeAttachment(true);
  };

  const sendToAgent = async (text: string): Promise<boolean> => {
    let target = attachedTabRef.current;
    const attachedExists = workspace.tabs.some(
      (candidate) =>
        candidate.id === target && candidate.worktreeId === worktreeId && candidate.agentId,
    );
    if (!target || !attachedExists) {
      attachedTabRef.current = null;
      if (!(await requestAgentAttachment())) return false;
      target = attachedTabRef.current;
    }
    if (!target) return false;
    try {
      await scratchpadPromptAgent(worktreeId, target, text);
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return false;
    }
  };

  const unresolved = comments.filter((comment) => comment.resolvedAt === null);
  const resolveComments = async (): Promise<void> => {
    const prompt = [
      "The user left the following scratchpad comments for you to address:",
      ...unresolved.map((comment, index) => `${index + 1}. On "${comment.quote}": ${comment.text}`),
    ].join("\n");
    if (!(await sendToAgent(prompt))) return;
    const resolvedAt = Date.now();
    updateComments(
      comments.map((comment) =>
        comment.resolvedAt === null ? { ...comment, resolvedAt } : comment,
      ),
    );
    toast.success("Comments sent to agent");
  };

  const placeholder = renderLoadState(state, load);
  if (placeholder) return placeholder;
  if (!document || documentError) {
    return <div className="p-6 text-sm text-destructive">{documentError}</div>;
  }

  const modeToggle = (
    <div className="flex items-center gap-2">
      {externalChange ? (
        <Button
          className="h-6 gap-1 px-2 text-xs"
          onClick={reloadFromDisk}
          title="This scratchpad changed on disk; reloading discards your unsaved edits"
          variant="secondary"
        >
          <RefreshCw className="size-3.5" />
          Changed on disk — reload
        </Button>
      ) : null}
      {unresolved.length > 0 ? (
        <Button
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => void resolveComments()}
          variant="secondary"
        >
          <MessagesSquare className="size-3.5" />
          Resolve comments ({unresolved.length})
        </Button>
      ) : null}
      <Tabs onValueChange={(value) => setMode(value as ScratchpadMode)} value={mode}>
        <TabsList className="h-6 p-0.5">
          <TabsTrigger className="px-2 text-xs" value="editor">
            Editor
          </TabsTrigger>
          <TabsTrigger className="px-2 text-xs" value="raw">
            Raw
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );

  const body = document.body;
  const agentTabs = workspace.tabs.filter(
    (candidate) =>
      candidate.worktreeId === worktreeId && candidate.kind === "terminal" && candidate.agentId,
  );

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas"
      onKeyDown={handleSaveShortcut}
    >
      {mode === "editor" && !commentsLoaded ? (
        <div className="flex h-full min-h-0 flex-col">
          <ScratchpadBar modeToggle={modeToggle} />
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            Loading comments...
          </div>
        </div>
      ) : mode === "editor" ? (
        <ScratchpadWysiwyg
          body={body}
          comments={comments}
          commentsEnabled={commentsLoaded}
          filePath={filePath ?? "scratchpad.mdx"}
          getAttachedAgentTabId={() => attachedTabRef.current}
          modeToggle={modeToggle}
          onBodyChange={updateBody}
          onCommentsChange={updateComments}
          onInlineEdit={(request) => {
            setInlineEditRequest(request);
            setMode("raw");
          }}
          onRequestAgentAttachment={requestAgentAttachment}
          onSave={() => void save(currentDocRef.current)}
          worktreeId={worktreeId}
        />
      ) : mode === "raw" ? (
        <div className="flex h-full min-h-0 flex-col">
          <ScratchpadBar modeToggle={modeToggle} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <MarkdownRaw
              doc={body}
              filePath={filePath}
              inlineEditRequest={inlineEditRequest}
              isRemote={isRemote}
              onInlineEditRequestHandled={() => setInlineEditRequest(null)}
              onChange={updateBody}
              save={saveBody}
              worktreeId={worktreeId}
            />
          </div>
        </div>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeAttachment(false);
        }}
        open={attachOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>No agent tab attached</DialogTitle>
            <DialogDescription>Choose an agent tab from this worktree.</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-72 gap-2 overflow-y-auto">
            {agentTabs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent tabs are available.</p>
            ) : (
              agentTabs.map((agentTab) => (
                <Button
                  className="justify-start"
                  key={agentTab.id}
                  onClick={() => void attachAgent(agentTab)}
                  variant="outline"
                >
                  {agentTab.title ?? agentTab.agentId}
                </Button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function writeScratchpadComments(
  worktreeId: string,
  filePath: string,
  comments: readonly ScratchpadComment[],
): Promise<void> {
  const path = scratchpadCommentsPath(filePath);
  const key = `${worktreeId}:${path}`;
  const queued = (commentWriteQueues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeFile(worktreeId, path, `${JSON.stringify(comments, null, 2)}\n`));
  commentWriteQueues.set(key, queued);
  const cleanup = (): void => {
    if (commentWriteQueues.get(key) === queued) commentWriteQueues.delete(key);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}

function commentsMeaningfullyChanged(
  previous: readonly ScratchpadComment[],
  next: readonly ScratchpadComment[],
): boolean {
  if (previous.length !== next.length) return true;
  return next.some((comment, index) => {
    const before = previous[index];
    return (
      !before ||
      before.id !== comment.id ||
      before.quote !== comment.quote ||
      before.text !== comment.text ||
      before.resolvedAt !== comment.resolvedAt
    );
  });
}
