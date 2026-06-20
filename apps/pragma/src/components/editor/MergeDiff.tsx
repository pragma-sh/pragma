import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MergeView } from "@codemirror/merge";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  lineNumbers,
} from "@codemirror/view";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";

/**
 * An inline review comment anchored to a 1-based line in the new (right-hand)
 * document. {@link MergeDiff} renders {@link content} as a block widget directly
 * beneath that line via a React portal, so review threads sit next to the code
 * they annotate.
 */
export interface DiffComment {
  /** Stable key (the thread id). */
  key: string;
  /** 1-based line in the new document to anchor the comment beneath. */
  line: number;
  /** Rendered comment content (mounted into the editor via a portal). */
  content: ReactNode;
}

/** Block widget whose DOM is a stable container we render a React portal into. */
class CommentWidget extends WidgetType {
  constructor(
    private readonly key: string,
    private readonly onMount: (key: string, el: HTMLElement) => void,
    private readonly onUnmount: (key: string) => void,
  ) {
    super();
  }

  override eq(other: CommentWidget): boolean {
    return other.key === this.key;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-review-comment";
    this.onMount(this.key, el);
    return el;
  }

  override destroy(): void {
    this.onUnmount(this.key);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function commentDecorations(
  newText: string,
  comments: DiffComment[],
  onMount: (key: string, el: HTMLElement) => void,
  onUnmount: (key: string) => void,
): DecorationSet {
  const { doc } = EditorState.create({ doc: newText });
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = comments
    .filter((comment) => comment.line >= 1 && comment.line <= doc.lines)
    .toSorted((a, b) => a.line - b.line);
  for (const comment of sorted) {
    const pos = doc.line(comment.line).to;
    builder.add(
      pos,
      pos,
      Decoration.widget({
        widget: new CommentWidget(comment.key, onMount, onUnmount),
        block: true,
        side: 1,
      }),
    );
  }
  return builder.finish();
}

/** Replaces the comment block-widget decorations in the new (right) editor. */
const setCommentDecorations = StateEffect.define<DecorationSet>();

/**
 * Holds the comment block-widget decorations as editor state. Updating it via
 * {@link setCommentDecorations} (instead of rebuilding the whole `MergeView`)
 * lets CodeMirror reconcile widgets by key — a widget whose key is unchanged
 * keeps its existing DOM node, so the React portal mounted into it is updated
 * in place rather than remounted (which would reset the card's collapsed/
 * resolving state). The set is mapped through document changes for safety,
 * though this read-only editor never edits its doc.
 */
const commentDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCommentDecorations)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const READ_ONLY = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/** Stable empty default so the `comments` prop keeps referential equality. */
const NO_COMMENTS: DiffComment[] = [];

/**
 * Read-only side-by-side diff rendered with `@codemirror/merge`. Presentational:
 * the caller supplies the old/new text (from a worktree `file_diff` or a PR's
 * local `base...HEAD` diff). The single place a `MergeView` is constructed, so
 * `DiffView` (worktree diffs) and `ReviewTab` (PR diffs) share one renderer.
 *
 * Both panes get a line-number gutter and syntax highlighting; `fileName` drives
 * grammar detection (loaded lazily and swapped in via a compartment). Optional
 * {@link comments} are mounted as block widgets beneath their anchor lines on the
 * new (right) side, aligning review threads with the code they reference.
 */
export function MergeDiff({
  oldText,
  newText,
  fileName,
  comments = NO_COMMENTS,
}: {
  oldText: string;
  newText: string;
  fileName?: string;
  comments?: DiffComment[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Widget DOM containers, keyed by comment key, populated as the editor mounts
  // each block widget. `version` re-renders the portals when the set changes.
  const portalsRef = useRef(new Map<string, HTMLElement>());
  const [, setVersion] = useState(0);
  // The live MergeView, kept across `comments` changes so decoration updates go
  // through `dispatch` (preserving widget DOM) rather than a full rebuild.
  const viewRef = useRef<MergeView | null>(null);
  // Latest comments, read by the create effect's initial dispatch without making
  // `comments` a dependency of view creation.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;

  const refreshPortals = useCallback(() => setVersion((value) => value + 1), []);
  const onMount = useCallback(
    (key: string, el: HTMLElement) => {
      portalsRef.current.set(key, el);
      queueMicrotask(refreshPortals);
    },
    [refreshPortals],
  );
  const onUnmount = useCallback(
    (key: string) => {
      portalsRef.current.delete(key);
      queueMicrotask(refreshPortals);
    },
    [refreshPortals],
  );

  // Create the MergeView. Deliberately excludes `comments`: comment changes are
  // pushed in via the effect below so the view (and its widget DOM) survive them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    portalsRef.current = new Map();

    const languageA = new Compartment();
    const languageB = new Compartment();
    const baseExtensions = (compartment: Compartment) => [
      ...READ_ONLY,
      lineNumbers(),
      pragmaSyntaxHighlighting,
      compartment.of([]),
      pragmaEditorTheme,
    ];

    const view = new MergeView({
      a: { doc: oldText, extensions: baseExtensions(languageA) },
      b: {
        doc: newText,
        extensions: [...baseExtensions(languageB), commentDecorationsField],
      },
      parent: container,
    });
    viewRef.current = view;
    if (view.b) {
      view.b.dispatch({
        effects: setCommentDecorations.of(
          commentDecorations(newText, commentsRef.current, onMount, onUnmount),
        ),
      });
    }

    let cancelled = false;
    // A missing/failed grammar must not break the diff; plain text still gets
    // the shared syntax palette for token styles a grammar can emit later.
    void (async () => {
      const languageExtension = fileName ? await loadLanguageExtension(fileName) : null;
      if (!cancelled && languageExtension && view.a && view.b) {
        view.a.dispatch({ effects: languageA.reconfigure(languageExtension) });
        view.b.dispatch({ effects: languageB.reconfigure(languageExtension) });
      }
    })();

    return () => {
      cancelled = true;
      viewRef.current = null;
      view.destroy();
    };
  }, [oldText, newText, fileName, onMount, onUnmount]);

  // Push comment changes into the live view. CodeMirror reuses widgets whose key
  // is unchanged, so persisting threads keep their DOM (and their React state).
  useEffect(() => {
    const view = viewRef.current;
    if (!view?.b) {
      return;
    }
    view.b.dispatch({
      effects: setCommentDecorations.of(commentDecorations(newText, comments, onMount, onUnmount)),
    });
  }, [comments, newText, onMount, onUnmount]);

  return (
    <>
      <div className="h-full min-h-0 overflow-auto bg-[#0b0d10]" ref={containerRef} />
      {comments.map((comment) => {
        const el = portalsRef.current.get(comment.key);
        return el ? createPortal(comment.content, el, comment.key) : null;
      })}
    </>
  );
}
