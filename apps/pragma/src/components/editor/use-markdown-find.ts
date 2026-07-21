import { useCallback, useMemo, useState } from "react";

import type { Editor } from "@tiptap/react";
import { Extension } from "@tiptap/react";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import {
  findFuzzyMatches,
  type FuzzyMatch,
  nextFuzzyMatch,
  previousFuzzyMatch,
} from "@/lib/fuzzy-match";
import {
  type FindReplaceApi,
  type FindReplaceState,
  useOpenBar,
  useSetIgnoreCase,
  useSetQuery,
  useSetReplaceValue,
} from "@/components/find-replace/find-replace-state";

export type MarkdownFindApi = FindReplaceApi;

const findPluginKey = new PluginKey<DecorationSet>("pragmaMarkdownFind");

interface FindMeta {
  matches: FuzzyMatch[];
  activeIndex: number;
}

/** ProseMirror plugin painting fuzzy-match highlights; state is pushed in via `setMeta`. */
export const markdownFindExtension = Extension.create({
  name: "pragmaMarkdownFind",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: findPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
            if (meta) {
              const decorations = meta.matches
                .filter((match) => match.to > match.from)
                .map((match, index) =>
                  Decoration.inline(match.from, match.to, {
                    class:
                      index === meta.activeIndex
                        ? "rounded-[2px] bg-amber-600/70"
                        : "rounded-[2px] bg-slate-500/50",
                  }),
                );
              return DecorationSet.create(tr.doc, decorations);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return findPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});

interface TextRun {
  text: string;
  /** Document position of each character in `text`, same index alignment. */
  positions: number[];
}

/** Flattens each textblock's inline content to a string + per-character doc positions. */
function collectTextRuns(doc: ProseMirrorNode): TextRun[] {
  const runs: TextRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    const chars: string[] = [];
    const positions: number[] = [];
    let offset = pos + 1;
    node.forEach((child) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i += 1) {
          chars.push(child.text[i]!);
          positions.push(offset + i);
        }
      }
      offset += child.nodeSize;
    });
    if (chars.length > 0) {
      runs.push({ text: chars.join(""), positions });
    }
    return false;
  });
  return runs;
}

/** Fuzzy-matches every textblock in the document, converting run-local indices to doc positions. */
function findDocumentMatches(
  doc: ProseMirrorNode,
  query: string,
  ignoreCase: boolean,
): FuzzyMatch[] {
  if (!query) {
    return [];
  }
  const matches: FuzzyMatch[] = [];
  for (const run of collectTextRuns(doc)) {
    for (const match of findFuzzyMatches(run.text, query, ignoreCase)) {
      const from = run.positions[match.from];
      const lastCharPos = run.positions[match.to - 1];
      if (from === undefined || lastCharPos === undefined) {
        continue;
      }
      matches.push({ from, to: lastCharPos + 1 });
    }
  }
  return matches;
}

/**
 * Fuzzy (subsequence) find/replace for the TipTap/ProseMirror WYSIWYG
 * surface. Matching only spans within a single textblock (paragraph,
 * heading, list item, …) — crossing block boundaries has no well-defined
 * document range to highlight or replace. `FindReplaceBar` is the UI; this
 * hook is the controller, driven by the `Editor` instance.
 */
// fallow-ignore-next-line complexity -- controller hook composing state + paint/recompute/goTo callbacks for one find/replace surface; each callback is already factored to its own useCallback.
export function useMarkdownFind(editor: Editor | null): MarkdownFindApi {
  const [state, setState] = useState<FindReplaceState>({
    open: false,
    query: "",
    replaceValue: "",
    ignoreCase: false,
    matchCount: 0,
    currentMatch: 0,
  });
  const [matches, setMatches] = useState<FuzzyMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const paint = useCallback(
    (nextMatches: FuzzyMatch[], nextActiveIndex: number) => {
      if (!editor) {
        return;
      }
      editor.view.dispatch(
        editor.state.tr.setMeta(findPluginKey, {
          matches: nextMatches,
          activeIndex: nextActiveIndex,
        }),
      );
    },
    [editor],
  );

  const recompute = useCallback(
    (query: string, ignoreCase: boolean, preferredFrom?: number) => {
      if (!editor) {
        return;
      }
      const found = findDocumentMatches(editor.state.doc, query, ignoreCase);
      let index = 0;
      if (found.length > 0) {
        const anchor = preferredFrom ?? editor.state.selection.head;
        const match = nextFuzzyMatch(found, anchor) ?? found[0];
        index = match ? found.indexOf(match) : 0;
      }
      setMatches(found);
      setActiveIndex(index);
      setState((previous) => ({
        ...previous,
        matchCount: found.length,
        currentMatch: found.length > 0 ? index + 1 : 0,
      }));
      paint(found, index);
    },
    [editor, paint],
  );

  const openBar = useOpenBar(setState);

  const closeBar = useCallback(() => {
    setState((previous) => ({ ...previous, open: false, matchCount: 0, currentMatch: 0 }));
    setMatches([]);
    setActiveIndex(0);
    paint([], 0);
  }, [paint]);

  // fallow-ignore-next-line code-duplication -- shared setQuery/setReplaceValue/setIgnoreCase calls already factored into find-replace-state.ts; the rest of the match is goTo's per-surface guard, not extractable logic.
  const setQuery = useSetQuery(setState, recompute, state.ignoreCase);
  const setReplaceValue = useSetReplaceValue(setState);
  const setIgnoreCase = useSetIgnoreCase(setState, recompute, state.query);

  const goTo = useCallback(
    (direction: "next" | "previous") => {
      if (!editor || matches.length === 0) {
        return;
      }
      const { from: selectionFrom, head } = editor.state.selection;
      const match =
        direction === "next"
          ? (nextFuzzyMatch(matches, head + 1) ?? matches[0])
          : (previousFuzzyMatch(matches, selectionFrom) ?? matches[matches.length - 1]);
      if (!match) {
        return;
      }
      const index = matches.indexOf(match);
      setActiveIndex(index);
      setState((previous) => ({ ...previous, currentMatch: index + 1 }));
      editor.chain().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();
      paint(matches, index);
    },
    [editor, matches, paint],
  );

  const findNext = useCallback(() => goTo("next"), [goTo]);
  const findPrevious = useCallback(() => goTo("previous"), [goTo]);

  const replaceOne = useCallback(() => {
    if (!editor || matches.length === 0) {
      return;
    }
    const match = matches[activeIndex] ?? matches[0];
    if (!match) {
      return;
    }
    editor.view.dispatch(editor.state.tr.insertText(state.replaceValue, match.from, match.to));
    recompute(state.query, state.ignoreCase, match.from + state.replaceValue.length);
  }, [editor, matches, activeIndex, state.replaceValue, state.query, state.ignoreCase, recompute]);

  const replaceAll = useCallback(() => {
    if (!editor || matches.length === 0) {
      return;
    }
    // Descending order so replacing a later match never shifts an earlier one's positions.
    let tr = editor.state.tr;
    for (const match of matches.toSorted((a, b) => b.from - a.from)) {
      tr = tr.insertText(state.replaceValue, match.from, match.to);
    }
    editor.view.dispatch(tr);
    recompute(state.query, state.ignoreCase, 0);
  }, [editor, matches, state.replaceValue, state.query, state.ignoreCase, recompute]);

  return useMemo(
    () => ({
      ...state,
      openBar,
      closeBar,
      setQuery,
      setReplaceValue,
      setIgnoreCase,
      findNext,
      findPrevious,
      replaceOne,
      replaceAll,
    }),
    [
      state,
      openBar,
      closeBar,
      setQuery,
      setReplaceValue,
      setIgnoreCase,
      findNext,
      findPrevious,
      replaceOne,
      replaceAll,
    ],
  );
}
