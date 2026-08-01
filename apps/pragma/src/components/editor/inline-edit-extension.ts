import { Facet, Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";

import { PortalWidget } from "@/components/editor/portal-widget";
import type { InlineEditHunk } from "@/lib/inline-edit";

/**
 * CodeMirror plumbing for the inline AI edit: the session state field, the
 * red/green diff decorations, the block widgets React renders into, and the
 * keyboard-only command set.
 *
 * The prompt UI mirrors design mode in the browser (pill input + circular
 * action button). Here the result comes back as a diff in the buffer instead
 * of an agent session.
 */

/** Where a session is in the ask → run → review cycle. */
export type InlineEditPhase = "prompting" | "running" | "reviewing" | "failed";

/** One inline-edit session, from the prompt box to the last resolved hunk. */
export interface InlineEditSession {
  phase: InlineEditPhase;
  /** Offset the prompt/summary widget is anchored to (end of the last selected line). */
  anchor: number;
  /** The highlighted region the instruction was written for. */
  selection: { from: number; to: number };
  /** Error text shown in the widget when `phase` is `failed`. */
  error: string;
  /** The model's one-line description of the change, shown above the diff. */
  summary: string;
  /** Unresolved hunks, in document order. */
  hunks: InlineEditHunk[];
  /** `id` of the hunk the keyboard commands act on. */
  focused: number;
  /** Identifies the in-flight request, so a stale response is ignored. */
  runId: number;
}

/** Opens a prompt box under the highlighted lines. */
export const startInlineEdit = StateEffect.define<{
  anchor: number;
  selection: { from: number; to: number };
  runId: number;
}>();

/** Marks the request as sent; the widget switches to its running state. */
export const runInlineEdit = StateEffect.define<{ runId: number }>();

/** Stops an in-flight request and returns to the editable prompt. */
export const abortInlineEdit = StateEffect.define<null>();

/** Shows the returned diff. Hunk offsets are in the post-change document. */
export const reviewInlineEdit = StateEffect.define<{ hunks: InlineEditHunk[]; summary: string }>();

/** Drops one hunk from the session once it has been accepted or rejected. */
export const resolveInlineEditHunk = StateEffect.define<{ id: number }>();

/** Moves the keyboard focus between hunks. */
export const focusInlineEditHunk = StateEffect.define<{ id: number }>();

/** Reports a failed request in place of the prompt box. */
export const failInlineEdit = StateEffect.define<{ message: string }>();

/** Ends the session and removes every widget. */
export const endInlineEdit = StateEffect.define<null>();

/** Maps one hunk's offsets through a document change. */
function mapHunk(
  hunk: InlineEditHunk,
  changes: { mapPos: (pos: number, assoc?: number) => number },
) {
  return {
    ...hunk,
    deleted: {
      from: changes.mapPos(hunk.deleted.from, 1),
      to: changes.mapPos(hunk.deleted.to, -1),
    },
    added: { from: changes.mapPos(hunk.added.from, 1), to: changes.mapPos(hunk.added.to, -1) },
  };
}

// fallow-ignore-next-line complexity -- session state machine over discrete effects; each arm is a single transition.
function applyEffect(
  session: InlineEditSession | null,
  effect: StateEffect<unknown>,
): InlineEditSession | null {
  if (effect.is(startInlineEdit)) {
    return {
      phase: "prompting",
      anchor: effect.value.anchor,
      selection: effect.value.selection,
      error: "",
      summary: "",
      hunks: [],
      focused: 0,
      runId: effect.value.runId,
    };
  }
  if (!session) {
    return session;
  }
  if (effect.is(endInlineEdit)) {
    return null;
  }
  if (effect.is(runInlineEdit)) {
    return { ...session, phase: "running", error: "", runId: effect.value.runId };
  }
  if (effect.is(abortInlineEdit)) {
    return { ...session, phase: "prompting", error: "" };
  }
  if (effect.is(failInlineEdit)) {
    return { ...session, phase: "failed", error: effect.value.message };
  }
  if (effect.is(reviewInlineEdit)) {
    return {
      ...session,
      phase: "reviewing",
      summary: effect.value.summary,
      hunks: effect.value.hunks,
      focused: effect.value.hunks[0]?.id ?? 0,
    };
  }
  if (effect.is(resolveInlineEditHunk)) {
    const hunks = session.hunks.filter((hunk) => hunk.id !== effect.value.id);
    if (hunks.length === 0) {
      return null;
    }
    const focused = hunks.some((hunk) => hunk.id === session.focused)
      ? session.focused
      : (hunks[0]?.id ?? 0);
    return { ...session, hunks, focused };
  }
  if (effect.is(focusInlineEditHunk)) {
    return { ...session, focused: effect.value.id };
  }
  return session;
}

/** The active inline-edit session, or null when there is none. */
export const inlineEditField = StateField.define<InlineEditSession | null>({
  create: () => null,
  update(value, transaction) {
    let session = value;
    if (session && transaction.docChanged) {
      session = {
        ...session,
        anchor: transaction.changes.mapPos(session.anchor, 1),
        selection: {
          from: transaction.changes.mapPos(session.selection.from, 1),
          to: transaction.changes.mapPos(session.selection.to, -1),
        },
        hunks: session.hunks.map((hunk) => mapHunk(hunk, transaction.changes)),
      };
    }
    for (const effect of transaction.effects) {
      session = applyEffect(session, effect);
    }
    return session;
  },
});

/** What a portal widget stands in for. */
export type InlineEditPortalKind = "prompt" | "hunk";

/** A live widget container React renders into. */
export interface InlineEditPortal {
  /** Stable per widget, so React keeps the DOM (and the textarea's state). */
  key: string;
  kind: InlineEditPortalKind;
  dom: HTMLElement;
  /** Set for `hunk` portals: which hunk the bar belongs to. */
  hunkId: number;
}

/** Receives widget containers as CodeMirror creates and destroys them. */
export interface InlineEditPortalHost {
  mount: (portal: InlineEditPortal) => void;
  unmount: (key: string) => void;
}

/** The host React installs so widgets can hand it their containers. */
export const inlineEditPortalHost = Facet.define<InlineEditPortalHost, InlineEditPortalHost | null>(
  {
    combine: (values) => values[0] ?? null,
  },
);

/** A block widget that reports its container to the host as `kind`/`hunkId`. */
function portalWidget(
  host: InlineEditPortalHost | null,
  key: string,
  kind: InlineEditPortalKind,
  hunkId: number,
): PortalWidget {
  return new PortalWidget(
    key,
    "cm-inline-edit-portal",
    (_key, dom) => host?.mount({ key, kind, dom, hunkId }),
    (mounted) => host?.unmount(mounted),
  );
}

/**
 * The lines a hunk range covers. A range that ends at the end of the document
 * starts on the newline of the *previous* line (there is no trailing one to
 * delete), so step over it before resolving lines.
 */
function lineSpan(
  doc: Text,
  range: { from: number; to: number },
): { from: number; to: number } | null {
  if (range.from >= range.to) {
    return null;
  }
  const from = doc.sliceString(range.from, range.from + 1) === "\n" ? range.from + 1 : range.from;
  return from < range.to ? { from, to: range.to } : null;
}

function pushLineDecorations(
  doc: Text,
  span: { from: number; to: number },
  className: string,
  into: Array<{ from: number; value: Decoration }>,
): void {
  const decoration = Decoration.line({ class: className });
  for (let pos = span.from; pos <= span.to; ) {
    const line = doc.lineAt(pos);
    into.push({ from: line.from, value: decoration });
    if (line.to >= span.to) {
      break;
    }
    pos = line.to + 1;
  }
}

/** Start of the block a hunk occupies, used to place its accept/reject bar. */
function hunkStart(doc: Text, hunk: InlineEditHunk): number {
  const span = lineSpan(doc, hunk.deleted) ?? lineSpan(doc, hunk.added);
  return doc.lineAt(span?.from ?? hunk.added.from).from;
}

function buildDecorations(
  session: InlineEditSession | null,
  doc: Text,
  host: InlineEditPortalHost | null,
): DecorationSet {
  if (!session) {
    return Decoration.none;
  }
  const ranges: Array<{ from: number; to?: number; value: Decoration }> = [];

  if (session.phase !== "reviewing") {
    const line = doc.lineAt(Math.min(session.anchor, doc.length));
    ranges.push({
      from: line.to,
      value: Decoration.widget({
        widget: portalWidget(host, "prompt", "prompt", -1),
        block: true,
        side: 1,
      }),
    });
    const selection = lineSpan(doc, session.selection) ?? {
      from: session.selection.from,
      to: session.selection.from,
    };
    if (selection.from < selection.to) {
      pushLineDecorations(doc, selection, "cm-inline-edit-selected", ranges);
    }
  }

  for (const hunk of session.hunks) {
    ranges.push({
      from: hunkStart(doc, hunk),
      value: Decoration.widget({
        widget: portalWidget(host, `hunk-${hunk.id}`, "hunk", hunk.id),
        block: true,
        side: -1,
      }),
    });
    const deleted = lineSpan(doc, hunk.deleted);
    if (deleted) {
      pushLineDecorations(doc, deleted, "cm-inline-edit-deleted", ranges);
    }
    const added = lineSpan(doc, hunk.added);
    if (added) {
      pushLineDecorations(doc, added, "cm-inline-edit-added", ranges);
    }
  }

  return Decoration.set(
    ranges.map((range) => range.value.range(range.from, range.to ?? range.from)),
    true,
  );
}

/** Red/green line highlighting plus the widget containers, derived from the session. */
export const inlineEditDecorations = EditorView.decorations.compute(
  [inlineEditField, inlineEditPortalHost, "doc"],
  (state) =>
    buildDecorations(
      state.field(inlineEditField, false) ?? null,
      state.doc,
      state.facet(inlineEditPortalHost),
    ),
);

/** Colors for the inline diff, taken from the app's theme tokens. */
export const inlineEditTheme = EditorView.baseTheme({
  ".cm-line.cm-inline-edit-deleted": {
    backgroundColor: "color-mix(in oklab, var(--diff-removed) 18%, transparent)",
  },
  ".cm-line.cm-inline-edit-added": {
    backgroundColor: "color-mix(in oklab, var(--diff-added) 18%, transparent)",
  },
  ".cm-line.cm-inline-edit-selected": {
    backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
  },
  ".cm-inline-edit-portal": {
    padding: "2px 0",
  },
});

/** Commands the inline-edit keymap needs from the React layer. */
export interface InlineEditCommands {
  /** ⌘/Ctrl+K — open the prompt box under the selection. */
  start: (view: EditorView) => boolean;
  /** Esc — cancel a prompt/run, or reject everything left in a review. */
  dismiss: (view: EditorView) => boolean;
  /** Accept or reject the focused hunk, or every remaining hunk. */
  resolve: (view: EditorView, decision: "accept" | "reject", scope: "one" | "all") => boolean;
  /** Move the keyboard focus to the next/previous hunk. */
  moveFocus: (view: EditorView, direction: 1 | -1) => boolean;
  /** ⌘/Ctrl+S while reviewing — blocked, because the buffer holds both sides. */
  blockSave: (view: EditorView) => boolean;
}

/**
 * The keyboard-only control scheme, at the highest precedence so it wins over
 * the editor's own save/find bindings while a session is open.
 *
 * ⌘/Ctrl+K opens the pill; Enter submits (handled in the prompt itself); Esc
 * backs out; ⌘/Ctrl+Enter and ⌘/Ctrl+Backspace accept and reject the focused
 * hunk, with Shift widening either to every hunk; Alt and the arrow keys walk
 * between hunks.
 */
export function inlineEditKeymap(commands: InlineEditCommands): Extension {
  const whenActive =
    (run: (view: EditorView) => boolean) =>
    (view: EditorView): boolean =>
      view.state.field(inlineEditField, false) ? run(view) : false;

  return Prec.highest(
    keymap.of([
      { key: "Mod-k", preventDefault: true, run: commands.start },
      { key: "Escape", run: whenActive(commands.dismiss) },
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: whenActive((view) => commands.resolve(view, "accept", "one")),
      },
      {
        key: "Mod-Backspace",
        preventDefault: true,
        run: whenActive((view) => commands.resolve(view, "reject", "one")),
      },
      {
        key: "Mod-Shift-Enter",
        preventDefault: true,
        run: whenActive((view) => commands.resolve(view, "accept", "all")),
      },
      {
        key: "Mod-Shift-Backspace",
        preventDefault: true,
        run: whenActive((view) => commands.resolve(view, "reject", "all")),
      },
      { key: "Alt-ArrowDown", run: whenActive((view) => commands.moveFocus(view, 1)) },
      { key: "Alt-ArrowUp", run: whenActive((view) => commands.moveFocus(view, -1)) },
      { key: "Mod-s", run: whenActive(commands.blockSave) },
    ]),
  );
}
