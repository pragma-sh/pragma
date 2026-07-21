import { useCallback, useMemo, useState } from "react";

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

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

export interface EditorFindApi extends FindReplaceApi {
  extension: Extension;
  /** Recomputes match highlighting; call after the document changes elsewhere. */
  refreshMatches: () => void;
}

interface FuzzyDecorationPayload {
  matches: FuzzyMatch[];
  activeIndex: number;
}

const matchMark = Decoration.mark({ class: "cm-fuzzy-match" });
const activeMatchMark = Decoration.mark({ class: "cm-fuzzy-match-active" });

const setFuzzyDecorations = StateEffect.define<FuzzyDecorationPayload>();

function buildDecorations({ matches, activeIndex }: FuzzyDecorationPayload): DecorationSet {
  const ranges = matches
    .filter((match) => match.to > match.from)
    .map((match, index) =>
      (index === activeIndex ? activeMatchMark : matchMark).range(match.from, match.to),
    );
  return Decoration.set(ranges, true);
}

/** Holds the fuzzy-match highlight decorations; painted via `EditorView.decorations`. */
const fuzzyMatchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFuzzyDecorations)) {
        next = buildDecorations(effect.value);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Fuzzy (subsequence) find/replace for CodeMirror, driven headlessly — no
 * built-in `@codemirror/search` panel or matching. That package's matching is
 * exact-substring/regex only, and its `replaceNext`/`replaceAll` commands
 * only replace a match the selection is already sitting on — so both the
 * matching mode and the replace semantics here are custom. `FindReplaceBar`
 * is the UI; this hook is the controller wired to a `viewRef`.
 */
// fallow-ignore-next-line complexity -- controller hook composing state + paint/recompute/goTo callbacks for one find/replace surface; each callback is already factored to its own useCallback.
export function useEditorFind(viewRef: { current: EditorView | null }): EditorFindApi {
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

  const extension = useMemo(() => fuzzyMatchField, []);

  const paint = useCallback((nextMatches: FuzzyMatch[], nextActiveIndex: number) => {
    viewRef.current?.dispatch({
      effects: setFuzzyDecorations.of({ matches: nextMatches, activeIndex: nextActiveIndex }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Recomputes matches from the live document and re-paints, keeping the match nearest `preferredFrom` active. */
  const recompute = useCallback(
    (query: string, ignoreCase: boolean, preferredFrom?: number) => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      const found = query ? findFuzzyMatches(view.state.doc.toString(), query, ignoreCase) : [];
      let index = 0;
      if (found.length > 0) {
        const anchor = preferredFrom ?? view.state.selection.main.to;
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
    [paint, viewRef],
  );

  const openBar = useOpenBar(setState);

  const closeBar = useCallback(() => {
    const view = viewRef.current;
    setState((previous) => ({ ...previous, open: false, matchCount: 0, currentMatch: 0 }));
    setMatches([]);
    setActiveIndex(0);
    paint([], 0);
    view?.focus();
  }, [paint, viewRef]);

  // fallow-ignore-next-line code-duplication -- shared setQuery/setReplaceValue/setIgnoreCase calls already factored into find-replace-state.ts; the rest of the match is goTo's per-surface guard, not extractable logic.
  const setQuery = useSetQuery(setState, recompute, state.ignoreCase);
  const setReplaceValue = useSetReplaceValue(setState);
  const setIgnoreCase = useSetIgnoreCase(setState, recompute, state.query);

  const refreshMatches = useCallback(() => {
    recompute(state.query, state.ignoreCase);
  }, [recompute, state.query, state.ignoreCase]);

  const goTo = useCallback(
    (direction: "next" | "previous") => {
      const view = viewRef.current;
      if (!view || matches.length === 0) {
        return;
      }
      const { from: selectionFrom, to: selectionTo } = view.state.selection.main;
      const match =
        direction === "next"
          ? (nextFuzzyMatch(matches, selectionTo + 1) ?? matches[0])
          : (previousFuzzyMatch(matches, selectionFrom) ?? matches[matches.length - 1]);
      if (!match) {
        return;
      }
      const index = matches.indexOf(match);
      setActiveIndex(index);
      setState((previous) => ({ ...previous, currentMatch: index + 1 }));
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
        effects: [
          setFuzzyDecorations.of({ matches, activeIndex: index }),
          EditorView.scrollIntoView(match.from, { y: "center" }),
        ],
      });
    },
    [matches, viewRef],
  );

  const findNext = useCallback(() => goTo("next"), [goTo]);
  const findPrevious = useCallback(() => goTo("previous"), [goTo]);

  const replaceOne = useCallback(() => {
    const view = viewRef.current;
    if (!view || matches.length === 0) {
      return;
    }
    const match = matches[activeIndex] ?? matches[0];
    if (!match) {
      return;
    }
    view.dispatch({
      changes: { from: match.from, to: match.to, insert: state.replaceValue },
      selection: { anchor: match.from + state.replaceValue.length },
      userEvent: "input.replace",
    });
    recompute(state.query, state.ignoreCase, match.from + state.replaceValue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, activeIndex, state.replaceValue, state.query, state.ignoreCase, recompute]);

  const replaceAll = useCallback(() => {
    const view = viewRef.current;
    if (!view || matches.length === 0) {
      return;
    }
    const changes = matches.map((match) => ({
      from: match.from,
      to: match.to,
      insert: state.replaceValue,
    }));
    view.dispatch({ changes, userEvent: "input.replace.all" });
    recompute(state.query, state.ignoreCase, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, state.replaceValue, state.query, state.ignoreCase, recompute]);

  return {
    ...state,
    extension,
    openBar,
    closeBar,
    setQuery,
    setReplaceValue,
    setIgnoreCase,
    findNext,
    findPrevious,
    replaceOne,
    replaceAll,
    refreshMatches,
  };
}
