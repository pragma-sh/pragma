import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { toast } from "sonner";

import { InlineEditHunkBar } from "@/components/editor/InlineEditHunkBar";
import { InlineEditPrompt } from "@/components/editor/InlineEditPrompt";
import {
  abortInlineEdit,
  endInlineEdit,
  failInlineEdit,
  focusInlineEditHunk,
  type InlineEditPortal,
  type InlineEditPortalHost,
  type InlineEditSession,
  inlineEditDecorations,
  inlineEditField,
  inlineEditKeymap,
  inlineEditPortalHost,
  inlineEditTheme,
  resolveInlineEditHunk,
  reviewInlineEdit,
  runInlineEdit,
  startInlineEdit,
} from "@/components/editor/inline-edit-extension";
import { errorMessage } from "@/lib/errors";
import {
  applyInlineEdits,
  buildInlineEditPreview,
  type InlineEditHunk,
  resolveHunkChange,
} from "@/lib/inline-edit";
import { aiInlineEdit } from "@/lib/tauri";

/** What {@link useInlineEdit} gives the editor component. */
export interface InlineEdit {
  /** CodeMirror extension: state, decorations, keymap, and widget hosting. */
  extension: Extension;
  /** The prompt box and hunk bars, rendered into CodeMirror's block widgets. */
  portals: ReactNode;
}

interface UseInlineEditOptions {
  /** Live CodeMirror instance; null until the editor mounts. */
  viewRef: { current: EditorView | null };
  worktreeId: string;
  /** Worktree-relative path of the open file. */
  filePath: string | null;
  /**
   * True when the worktree lives on an SSH host. Inline edit runs a local
   * sidecar against `--cwd`, so remote projects are refused until host-routed
   * AI exists.
   */
  isRemote?: boolean;
}

/** The lines a hunk's decision removes, as a CodeMirror change. */
function hunkChange(hunk: InlineEditHunk, decision: "accept" | "reject") {
  const range = resolveHunkChange(hunk, decision);
  return { from: range.from, to: range.to, insert: "" };
}

function failEdit(view: EditorView, message: string): void {
  view.dispatch({ effects: failInlineEdit.of({ message }) });
}

/** Apply a draft to the live buffer, or fail the session if it is no longer usable. */
function presentInlineEditResult(
  view: EditorView,
  doc: string,
  draft: { summary: string; edits: Parameters<typeof applyInlineEdits>[1] },
): void {
  if (view.state.doc.toString() !== doc) {
    failEdit(view, "The file changed while the edit was running. Try again.");
    return;
  }
  const applied = applyInlineEdits(doc, draft.edits);
  if (applied.applied === 0) {
    failEdit(view, draft.summary || "The model proposed no usable edits.");
    return;
  }
  if (applied.skipped.length > 0) {
    toast.warning(
      `Skipped ${applied.skipped.length} edit${applied.skipped.length === 1 ? "" : "s"} that no longer matched the file.`,
    );
  }
  const preview = buildInlineEditPreview(doc, applied.doc);
  if (preview.hunks.length === 0) {
    failEdit(view, "That edit would not change anything.");
    return;
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: preview.doc },
    effects: [
      reviewInlineEdit.of({ hunks: preview.hunks, summary: draft.summary }),
      EditorView.scrollIntoView(preview.hunks[0]?.added.from ?? 0, { y: "center" }),
    ],
  });
  view.focus();
}

/**
 * Inline AI editing for a CodeMirror surface: ⌘/Ctrl+K opens a design-mode-style
 * pill under the highlighted lines, the model answers with edits anywhere in the
 * file, and the result lands in the buffer as a red/green diff with per-hunk
 * accept and reject — all driven from the keyboard.
 *
 * The model may search the whole repository but cannot write to it; the buffer
 * (which is often unsaved) stays the only source of truth, and nothing reaches
 * disk until the user accepts a hunk and saves.
 */
// fallow-ignore-next-line complexity -- one feature's controller: it owns the session lifecycle (open/run/review/resolve) for one editor, and splitting it would only scatter the shared view/session plumbing.
export function useInlineEdit({
  viewRef,
  worktreeId,
  filePath,
  isRemote = false,
}: UseInlineEditOptions): InlineEdit {
  const [portals, setPortals] = useState<InlineEditPortal[]>([]);
  const [session, setSession] = useState<InlineEditSession | null>(null);
  const runIdRef = useRef(0);

  const host = useMemo<InlineEditPortalHost>(
    () => ({
      mount: (portal) =>
        setPortals((current) => [...current.filter((item) => item.key !== portal.key), portal]),
      unmount: (key) => setPortals((current) => current.filter((item) => item.key !== key)),
    }),
    [],
  );

  const close = useCallback((view: EditorView) => {
    view.dispatch({ effects: endInlineEdit.of(null) });
    view.focus();
    return true;
  }, []);

  const resolve = useCallback(
    (view: EditorView, decision: "accept" | "reject", scope: "one" | "all") => {
      const current = view.state.field(inlineEditField, false);
      if (!current || current.phase !== "reviewing") {
        return false;
      }
      const targets =
        scope === "all"
          ? current.hunks
          : [current.hunks.find((hunk) => hunk.id === current.focused) ?? current.hunks[0]].filter(
              (hunk): hunk is InlineEditHunk => Boolean(hunk),
            );
      if (targets.length === 0) {
        return false;
      }
      view.dispatch({
        changes: targets.map((hunk) => hunkChange(hunk, decision)),
        effects: targets.map((hunk) => resolveInlineEditHunk.of({ id: hunk.id })),
      });
      const next = view.state.field(inlineEditField, false);
      const focused = next?.hunks.find((hunk) => hunk.id === next.focused);
      if (focused) {
        view.dispatch({ effects: EditorView.scrollIntoView(focused.added.from, { y: "center" }) });
      }
      view.focus();
      return true;
    },
    [],
  );

  const dismiss = useCallback(
    (view: EditorView) => {
      const current = view.state.field(inlineEditField, false);
      if (current?.phase === "reviewing") {
        return resolve(view, "reject", "all");
      }
      runIdRef.current += 1;
      return close(view);
    },
    [close, resolve],
  );

  /** Drop an in-flight request and reopen the editable pill with the same text. */
  const abort = useCallback((view: EditorView) => {
    runIdRef.current += 1;
    view.dispatch({ effects: abortInlineEdit.of(null) });
  }, []);

  const submit = useCallback(
    async (instruction: string) => {
      const view = viewRef.current;
      const current = view?.state.field(inlineEditField, false);
      if (!view || !current || !filePath) {
        return;
      }
      runIdRef.current += 1;
      const runId = runIdRef.current;
      const doc = view.state.doc.toString();
      const startLine = view.state.doc.lineAt(current.selection.from).number;
      const endLine = view.state.doc.lineAt(current.selection.to).number;
      view.dispatch({ effects: runInlineEdit.of({ runId }) });

      try {
        const draft = await aiInlineEdit({
          worktreeId,
          filePath,
          doc,
          instruction,
          startLine,
          endLine,
        });
        if (runIdRef.current !== runId || !viewRef.current) {
          return;
        }
        presentInlineEditResult(viewRef.current, doc, draft);
      } catch (error) {
        if (runIdRef.current === runId && viewRef.current) {
          failEdit(viewRef.current, errorMessage(error));
        }
      }
    },
    [filePath, viewRef, worktreeId],
  );

  const extension = useMemo<Extension>(() => {
    const start = (view: EditorView) => {
      if (!filePath) {
        return false;
      }
      if (isRemote) {
        toast.info("Inline AI edit is not available for remote worktrees yet.");
        return false;
      }
      const range = view.state.selection.main;
      const firstLine = view.state.doc.lineAt(range.from);
      const lastLine = view.state.doc.lineAt(range.to);
      runIdRef.current += 1;
      view.dispatch({
        effects: startInlineEdit.of({
          anchor: lastLine.to,
          selection: { from: firstLine.from, to: lastLine.to },
          runId: runIdRef.current,
        }),
      });
      return true;
    };

    return [
      inlineEditField,
      inlineEditDecorations,
      inlineEditTheme,
      inlineEditPortalHost.of(host),
      inlineEditKeymap({
        start,
        dismiss,
        resolve,
        moveFocus: (view, direction) => {
          const current = view.state.field(inlineEditField, false);
          if (!current || current.hunks.length === 0) {
            return false;
          }
          const at = current.hunks.findIndex((hunk) => hunk.id === current.focused);
          const next =
            current.hunks[Math.max(0, Math.min(current.hunks.length - 1, at + direction))];
          if (!next || next.id === current.focused) {
            return true;
          }
          view.dispatch({
            effects: [
              focusInlineEditHunk.of({ id: next.id }),
              EditorView.scrollIntoView(next.added.from, { y: "center" }),
            ],
          });
          return true;
        },
        blockSave: (view) => {
          if (view.state.field(inlineEditField, false)?.phase !== "reviewing") {
            return false;
          }
          toast.info("Accept or reject the AI edit before saving.");
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        const next = update.state.field(inlineEditField, false) ?? null;
        if (next !== (update.startState.field(inlineEditField, false) ?? null)) {
          setSession(next);
        }
      }),
    ];
  }, [dismiss, filePath, host, isRemote, resolve]);

  const rendered = portals.map((portal) => {
    if (!session) {
      return null;
    }
    if (portal.kind === "prompt") {
      return createPortal(
        <InlineEditPrompt
          error={session.error}
          phase={session.phase}
          onAbort={() => {
            const view = viewRef.current;
            if (view) {
              abort(view);
            }
          }}
          onCancel={() => {
            const view = viewRef.current;
            if (view) {
              dismiss(view);
            }
          }}
          onSubmit={(instruction) => void submit(instruction)}
        />,
        portal.dom,
        portal.key,
      );
    }
    const index = session.hunks.findIndex((hunk) => hunk.id === portal.hunkId);
    if (index < 0) {
      return null;
    }
    return createPortal(
      <InlineEditHunkBar
        focused={session.focused === portal.hunkId}
        index={index + 1}
        summary={session.summary}
        total={session.hunks.length}
        onResolve={(decision) => {
          const view = viewRef.current;
          if (view) {
            view.dispatch({ effects: focusInlineEditHunk.of({ id: portal.hunkId }) });
            resolve(view, decision, "one");
          }
        }}
        onResolveAll={(decision) => {
          const view = viewRef.current;
          if (view) {
            resolve(view, decision, "all");
          }
        }}
      />,
      portal.dom,
      portal.key,
    );
  });

  return { extension, portals: rendered };
}
