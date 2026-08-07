import { parseScratchpadComments, type ScratchpadComment } from "@pragma/scratchpad-viewer";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

// The comment-thread file is shared with the mobile client, so its shape and
// parser live in `@pragma/scratchpad-viewer`; this module owns only the TipTap
// decorations and picker that are specific to the desktop editor.
export { parseScratchpadComments, type ScratchpadComment };

const commentKey = new PluginKey<ScratchpadComment[]>("scratchpadComments");

/** TipTap decorations for unresolved scratchpad comment ranges. */
export const ScratchpadCommentsExtension = Extension.create({
  name: "scratchpadComments",
  addProseMirrorPlugins() {
    return [
      new Plugin<ScratchpadComment[]>({
        key: commentKey,
        state: {
          init: () => [],
          apply(transaction, current) {
            const replacement = transaction.getMeta(commentKey) as ScratchpadComment[] | undefined;
            if (replacement) return replacement;
            if (!transaction.docChanged) return current;
            return current.map((comment) => ({
              ...comment,
              from: transaction.mapping.map(comment.from),
              to: transaction.mapping.map(comment.to, -1),
            }));
          },
        },
        props: {
          decorations(state) {
            const comments = commentKey.getState(state) ?? [];
            return DecorationSet.create(
              state.doc,
              comments
                .filter((comment) => comment.resolvedAt === null && comment.from < comment.to)
                .map((comment) =>
                  Decoration.inline(comment.from, comment.to, {
                    class:
                      "rounded-sm bg-amber-400/25 underline decoration-amber-400/70 decoration-2 underline-offset-2",
                    "data-comment-id": comment.id,
                  }),
                ),
            );
          },
        },
      }),
    ];
  },
});

/** Replaces comment decorations in one TipTap editor. */
export function setScratchpadCommentDecorations(
  editor: Editor,
  comments: readonly ScratchpadComment[],
): void {
  const max = editor.state.doc.content.size;
  const valid = comments
    .map((comment) => ({
      ...comment,
      from: Math.max(1, Math.min(comment.from, max)),
      to: Math.max(1, Math.min(comment.to, max)),
    }))
    .filter((comment) => comment.from < comment.to);
  editor.view.dispatch(editor.state.tr.setMeta(commentKey, valid));
}

/** Reads mapped comment ranges from current TipTap plugin state. */
export function scratchpadCommentDecorations(editor: Editor): ScratchpadComment[] {
  return commentKey.getState(editor.state) ?? [];
}

/** One document range picked for commenting. */
export interface ScratchpadRange {
  from: number;
  to: number;
}

interface PickerState {
  active: boolean;
  hover: ScratchpadRange | null;
  target: ScratchpadRange | null;
}

const pickerKey = new PluginKey<PickerState>("scratchpadCommentPicker");
const EMPTY_PICKER: PickerState = { active: false, hover: null, target: null };

/**
 * Browser-devtools-style element picker: while active the surface stops taking
 * edits, the block under the pointer is outlined, and a click freezes it as the
 * comment target.
 */
export const ScratchpadCommentPickerExtension = Extension.create<{
  onHover: (range: ScratchpadRange | null) => void;
  onPick: (range: ScratchpadRange | null) => void;
}>({
  name: "scratchpadCommentPicker",
  addOptions() {
    return { onHover: () => undefined, onPick: () => undefined };
  },
  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin<PickerState>({
        key: pickerKey,
        state: {
          init: () => EMPTY_PICKER,
          apply(transaction, current) {
            const meta = transaction.getMeta(pickerKey) as Partial<PickerState> | undefined;
            if (meta) return { ...current, ...meta };
            if (!transaction.docChanged) return current;
            return {
              ...current,
              hover: null,
              target: current.target && {
                from: transaction.mapping.map(current.target.from),
                to: transaction.mapping.map(current.target.to, -1),
              },
            };
          },
        },
        props: {
          attributes(state): Record<string, string> {
            const picker = pickerKey.getState(state) ?? EMPTY_PICKER;
            return picker.active ? { class: "scratchpad-picking" } : {};
          },
          handleDOMEvents: {
            mousemove(view, event) {
              const picker = pickerKey.getState(view.state) ?? EMPTY_PICKER;
              // A picked block freezes the overlay, as it does in the browser.
              if (!picker.active || picker.target) return false;
              const hover = blockRangeAtCoords(view, event.clientX, event.clientY);
              if (sameRange(hover, picker.hover)) return false;
              view.dispatch(view.state.tr.setMeta(pickerKey, { hover }));
              options.onHover(hover);
              return false;
            },
            mouseleave(view) {
              const picker = pickerKey.getState(view.state) ?? EMPTY_PICKER;
              if (!picker.active || !picker.hover) return false;
              view.dispatch(view.state.tr.setMeta(pickerKey, { hover: null }));
              options.onHover(null);
              return false;
            },
            mousedown(view, event) {
              const picker = pickerKey.getState(view.state) ?? EMPTY_PICKER;
              if (!picker.active) return false;
              const target = blockRangeAtCoords(view, event.clientX, event.clientY);
              event.preventDefault();
              view.dispatch(view.state.tr.setMeta(pickerKey, { target, hover: target }));
              options.onHover(target);
              options.onPick(target);
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** Turns the devtools-style picker on or off, clearing any previous target. */
export function setScratchpadPickerActive(editor: Editor, active: boolean): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(pickerKey, { active, hover: null, target: null } satisfies PickerState),
  );
}

/** Clears the picked target while leaving the picker itself active. */
export function clearScratchpadPickerTarget(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(pickerKey, { target: null }));
}

/** Resolves the innermost block node containing viewport coordinates. */
function blockRangeAtCoords(view: EditorView, left: number, top: number): ScratchpadRange | null {
  const found = view.posAtCoords({ left, top });
  if (!found) return domBlockRange(view, left, top);
  const resolved = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  const depth = resolved.depth === 0 ? (found.inside >= 0 ? 0 : -1) : resolved.depth;
  if (depth < 0) return null;
  if (depth === 0) {
    // A direct doc child (atom/leaf block) reports depth 0 with `inside` at its start.
    const node = view.state.doc.nodeAt(found.inside);
    return node ? { from: found.inside, to: found.inside + node.nodeSize } : null;
  }
  return { from: resolved.before(depth), to: resolved.after(depth) };
}

/**
 * DOM fallback for coordinates `posAtCoords` cannot map to a caret — a rendered
 * JSX block is an atom node view whose contents are not editable text, so the
 * top-level element under the pointer is what identifies it.
 */
function domBlockRange(view: EditorView, left: number, top: number): ScratchpadRange | null {
  const element = view.dom.ownerDocument.elementFromPoint(left, top);
  if (!(element instanceof HTMLElement) || element === view.dom || !view.dom.contains(element)) {
    return null;
  }
  let block = element;
  while (block.parentElement && block.parentElement !== view.dom) block = block.parentElement;
  let pos: number;
  try {
    pos = view.posAtDOM(block, 0);
  } catch {
    return null;
  }
  const resolved = view.state.doc.resolve(Math.min(Math.max(pos, 0), view.state.doc.content.size));
  if (resolved.depth === 0) {
    const node = view.state.doc.nodeAt(resolved.pos);
    return node ? { from: resolved.pos, to: resolved.pos + node.nodeSize } : null;
  }
  return { from: resolved.before(1), to: resolved.after(1) };
}

function sameRange(a: ScratchpadRange | null, b: ScratchpadRange | null): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to;
}
