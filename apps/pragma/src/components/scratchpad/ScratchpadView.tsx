import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { EditorContent } from "@tiptap/react";
import { MessageSquarePlus, MessagesSquare, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { type MarkdownInlineEditRequest, MarkdownRaw } from "@/components/editor/MarkdownView";
import { MarkdownToolbar } from "@/components/editor/MarkdownToolbar";
import { renderLoadState } from "@/components/editor/use-editor-file";
import {
  measurePick,
  PickerOverlay,
  rangeQuote,
  type PickBox,
} from "@/components/scratchpad/ScratchpadPicker";
import {
  clearScratchpadPickerTarget,
  type ScratchpadComment,
  type ScratchpadRange,
  setScratchpadPickerActive,
} from "@/components/scratchpad/scratchpad-comments";
import { useScratchpadAgent } from "@/components/scratchpad/use-scratchpad-agent";
import { useScratchpadComments } from "@/components/scratchpad/use-scratchpad-comments";
import {
  useScratchpadEditor,
  type ScratchpadEditorOptions,
} from "@/components/scratchpad/use-scratchpad-editor";
import {
  useScratchpadFile,
  type ScratchpadFile,
} from "@/components/scratchpad/use-scratchpad-file";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

type ScratchpadMode = "editor" | "raw";

interface ScratchpadWysiwygProps {
  commentsEnabled: boolean;
  modeToggle: ReactNode;
  options: ScratchpadEditorOptions;
}

function ScratchpadWysiwyg({ commentsEnabled, modeToggle, options }: ScratchpadWysiwygProps) {
  const { comments, onCommentsChange } = options;
  const [commentMode, setCommentMode] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [hover, setHover] = useState<PickBox | null>(null);
  const [target, setTarget] = useState<PickBox | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onHoverRef = useRef<(range: ScratchpadRange | null) => void>(() => undefined);
  const onPickRef = useRef<(range: ScratchpadRange | null) => void>(() => undefined);

  const { editor, parseError } = useScratchpadEditor(options, {
    onHover: (range) => onHoverRef.current(range),
    onPick: (range) => onPickRef.current(range),
  });

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
    dismissTarget();
  };

  const dismissTarget = (): void => {
    setCommentText("");
    setTarget(null);
    clearScratchpadPickerTarget(editor);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScratchpadBar modeToggle={modeToggle}>
        <MarkdownToolbar editor={editor}>
          <CommentModeButton
            active={commentMode}
            enabled={commentsEnabled}
            onToggle={() => setCommentMode((active) => !active)}
          />
        </MarkdownToolbar>
      </ScratchpadBar>
      <div className="relative min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <EditorContent className="h-full" editor={editor} />
        {commentMode ? (
          <PickerOverlay
            container={scrollRef.current}
            hover={hover}
            onCancel={dismissTarget}
            onChange={setCommentText}
            onSubmit={addComment}
            target={target}
            value={commentText}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Toolbar toggle that hands the editing surface over to the comment picker. */
function CommentModeButton({
  active,
  enabled,
  onToggle,
}: {
  active: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn("h-6 gap-1 px-2 text-xs font-medium", active && "shadow-sm")}
      disabled={!enabled}
      onClick={onToggle}
      size="sm"
      title="Click any block to comment on it"
      variant={active ? "default" : "secondary"}
    >
      <MessageSquarePlus className="size-3.5" />
      {active ? "Done commenting" : "Comment"}
    </Button>
  );
}

function ScratchpadBar({ children, modeToggle }: { children?: ReactNode; modeToggle: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-elevated px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{children}</div>
      <div className="shrink-0">{modeToggle}</div>
    </div>
  );
}

/** Right-hand bar controls: disk-reload prompt, unresolved-comment handoff, Editor/Raw switch. */
function ScratchpadModeToggle({
  externalChange,
  mode,
  onModeChange,
  onReload,
  onResolveComments,
  unresolvedCount,
}: {
  externalChange: boolean;
  mode: ScratchpadMode;
  onModeChange: (mode: ScratchpadMode) => void;
  onReload: () => void;
  onResolveComments: () => void;
  unresolvedCount: number;
}) {
  return (
    <div className="flex items-center gap-2">
      {externalChange ? (
        <Button
          className="h-6 gap-1 px-2 text-xs"
          onClick={onReload}
          title="This scratchpad changed on disk; reloading discards your unsaved edits"
          variant="secondary"
        >
          <RefreshCw className="size-3.5" />
          Changed on disk — reload
        </Button>
      ) : null}
      {unresolvedCount > 0 ? (
        <Button className="h-6 gap-1 px-2 text-xs" onClick={onResolveComments} variant="secondary">
          <MessagesSquare className="size-3.5" />
          Resolve comments ({unresolvedCount})
        </Button>
      ) : null}
      <Tabs onValueChange={(value) => onModeChange(value as ScratchpadMode)} value={mode}>
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
}

/** Picks which agent terminal tab a scratchpad prompts when none is attached yet. */
function ScratchpadAttachDialog({
  agentTabs,
  onAttach,
  onClose,
  open,
}: {
  agentTabs: readonly Tab[];
  onAttach: (agentTab: Tab) => void;
  onClose: () => void;
  open: boolean;
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
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
                onClick={() => onAttach(agentTab)}
                variant="outline"
              >
                {agentTab.title ?? agentTab.agentId}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Managed, interactive MDX scratchpad tab. */
export function ScratchpadView({ tab }: { tab: Tab }) {
  const { worktreeId, filePath } = tab;
  const workspace = useWorkspace();
  const [mode, setMode] = useState<ScratchpadMode>("editor");
  const [inlineEditRequest, setInlineEditRequest] = useState<MarkdownInlineEditRequest | null>(
    null,
  );

  const file = useScratchpadFile(tab);
  const { comments, commentsLoaded, updateComments } = useScratchpadComments(
    worktreeId,
    filePath,
    file.state.kind === "ready",
  );
  const agent = useScratchpadAgent({
    worktreeId,
    currentDocRef: file.currentDocRef,
    onChange: file.onChange,
    save: file.save,
    onAttached: file.refreshDocument,
  });
  if (file.document) agent.attachedTabRef.current = file.document.metadata.agentTabId;

  const unresolved = comments.filter((comment) => comment.resolvedAt === null);
  const resolveComments = async (): Promise<void> => {
    if (!(await agent.sendToAgent(unresolvedCommentsPrompt(unresolved)))) return;
    updateComments(markAllResolved(comments));
    toast.success("Comments sent to agent");
  };

  const placeholder = renderLoadState(file.state, file.load);
  if (placeholder) return placeholder;
  if (!file.document) {
    return <div className="p-6 text-sm text-destructive">{file.documentError}</div>;
  }

  const modeToggle = (
    <ScratchpadModeToggle
      externalChange={file.externalChange}
      mode={mode}
      onModeChange={setMode}
      onReload={file.reloadFromDisk}
      onResolveComments={() => void resolveComments()}
      unresolvedCount={unresolved.length}
    />
  );
  const editorOptions: ScratchpadEditorOptions = {
    body: file.document.body,
    comments,
    filePath: filePath ?? "scratchpad.mdx",
    getAttachedAgentTabId: () => agent.attachedTabRef.current,
    onBodyChange: file.updateBody,
    onCommentsChange: updateComments,
    onInlineEdit: (request) => {
      setInlineEditRequest(request);
      setMode("raw");
    },
    onRequestAgentAttachment: agent.requestAgentAttachment,
    onSave: () => void file.save(file.currentDocRef.current),
    worktreeId,
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas"
      onKeyDown={file.handleSaveShortcut}
    >
      {mode === "editor" ? (
        <ScratchpadEditorSurface
          commentsLoaded={commentsLoaded}
          modeToggle={modeToggle}
          options={editorOptions}
        />
      ) : (
        <ScratchpadRawSurface
          body={file.document.body}
          file={file}
          filePath={filePath}
          inlineEditRequest={inlineEditRequest}
          isRemote={workspace.remoteWorktrees[worktreeId] === true}
          modeToggle={modeToggle}
          onInlineEditRequestHandled={() => setInlineEditRequest(null)}
          worktreeId={worktreeId}
        />
      )}

      <ScratchpadAttachDialog
        agentTabs={agent.agentTabs}
        onAttach={(agentTab) => void agent.attachAgent(agentTab)}
        onClose={() => agent.closeAttachment(false)}
        open={agent.attachOpen}
      />
    </div>
  );
}

interface ScratchpadRawSurfaceProps {
  body: string;
  file: ScratchpadFile;
  filePath: string | null;
  inlineEditRequest: MarkdownInlineEditRequest | null;
  isRemote: boolean;
  modeToggle: ReactNode;
  onInlineEditRequestHandled: () => void;
  worktreeId: string;
}

/** Raw MDX source in a plain markdown editor, frontmatter and all. */
function ScratchpadRawSurface(props: ScratchpadRawSurfaceProps) {
  const { body, file, filePath, inlineEditRequest, isRemote, modeToggle } = props;
  const { onInlineEditRequestHandled, worktreeId } = props;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScratchpadBar modeToggle={modeToggle} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <MarkdownRaw
          doc={body}
          filePath={filePath}
          inlineEditRequest={inlineEditRequest}
          isRemote={isRemote}
          onInlineEditRequestHandled={onInlineEditRequestHandled}
          onChange={file.updateBody}
          save={file.saveBody}
          worktreeId={worktreeId}
        />
      </div>
    </div>
  );
}

/**
 * The WYSIWYG surface, held behind a placeholder until comments have loaded so the
 * editor never mounts with a comment set it would then have to reconcile.
 */
function ScratchpadEditorSurface({
  commentsLoaded,
  modeToggle,
  options,
}: {
  commentsLoaded: boolean;
  modeToggle: ReactNode;
  options: ScratchpadEditorOptions;
}) {
  if (!commentsLoaded) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ScratchpadBar modeToggle={modeToggle} />
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          Loading comments...
        </div>
      </div>
    );
  }
  return <ScratchpadWysiwyg commentsEnabled modeToggle={modeToggle} options={options} />;
}

/** Stamps every open comment as resolved at the current time. */
function markAllResolved(comments: readonly ScratchpadComment[]): ScratchpadComment[] {
  const resolvedAt = Date.now();
  return comments.map((comment) =>
    comment.resolvedAt === null ? { ...comment, resolvedAt } : comment,
  );
}

/** The handoff message an agent receives when the user resolves open comments. */
function unresolvedCommentsPrompt(unresolved: readonly ScratchpadComment[]): string {
  return [
    "The user left the following scratchpad comments for you to address:",
    ...unresolved.map((comment, index) => `${index + 1}. On "${comment.quote}": ${comment.text}`),
  ].join("\n");
}
