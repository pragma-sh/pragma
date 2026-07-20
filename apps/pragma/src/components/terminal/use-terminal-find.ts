import { useCallback, useEffect, useState } from "react";

import { findFuzzyMatches } from "@/lib/fuzzy-match";
import { terminalManager, type TerminalFuzzyMatch } from "@/lib/terminal-manager";

export interface TerminalFindState {
  open: boolean;
  query: string;
  replaceValue: string;
  ignoreCase: boolean;
  matchCount: number;
  currentMatch: number;
}

export interface TerminalFindApi extends TerminalFindState {
  openBar: () => void;
  closeBar: () => void;
  setQuery: (value: string) => void;
  setReplaceValue: (value: string) => void;
  setIgnoreCase: (value: boolean) => void;
  findNext: () => void;
  findPrevious: () => void;
  replaceOne: () => void;
  replaceAll: () => void;
}

/** Replaces the first fuzzy match of `query` in `line`. */
function replaceFirstFuzzy(
  line: string,
  query: string,
  replacement: string,
  ignoreCase: boolean,
): string {
  const match = findFuzzyMatches(line, query, ignoreCase)[0];
  if (!match) {
    return line;
  }
  return line.slice(0, match.from) + replacement + line.slice(match.to);
}

/** Replaces every fuzzy match of `query` in `line`. */
function replaceAllFuzzy(
  line: string,
  query: string,
  replacement: string,
  ignoreCase: boolean,
): string {
  const matches = findFuzzyMatches(line, query, ignoreCase);
  if (matches.length === 0) {
    return line;
  }
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += line.slice(cursor, match.from) + replacement;
    cursor = match.to;
  }
  return result + line.slice(cursor);
}

/**
 * Drives fuzzy (subsequence) find across the terminal's full scrollback —
 * scanned row by row and painted via `TerminalManager.setFuzzyHighlights` —
 * and replace, which (per the confirmed scope) only ever rewrites the
 * not-yet-submitted input line via `TerminalManager`'s local-echo mirror.
 */
export function useTerminalFind(tabId: string): TerminalFindApi {
  const [state, setState] = useState<TerminalFindState>({
    open: false,
    query: "",
    replaceValue: "",
    ignoreCase: false,
    matchCount: 0,
    currentMatch: 0,
  });
  const [matches, setMatches] = useState<TerminalFuzzyMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(
    () => terminalManager.onRequestFind(tabId, () => setState((p) => ({ ...p, open: true }))),
    [tabId],
  );

  const recompute = useCallback(
    (query: string, ignoreCase: boolean) => {
      const lines = terminalManager.getBufferLines(tabId);
      const found: TerminalFuzzyMatch[] = [];
      if (query) {
        lines.forEach((line, row) => {
          for (const match of findFuzzyMatches(line, query, ignoreCase)) {
            found.push({ row, from: match.from, to: match.to });
          }
        });
      }
      setMatches(found);
      setActiveIndex(0);
      setState((previous) => ({
        ...previous,
        matchCount: found.length,
        currentMatch: found.length > 0 ? 1 : 0,
      }));
      terminalManager.setFuzzyHighlights(tabId, found, 0);
      const first = found[0];
      if (first) {
        terminalManager.scrollToBufferRow(tabId, first.row);
      }
    },
    [tabId],
  );

  const openBar = useCallback(() => setState((p) => ({ ...p, open: true })), []);

  const closeBar = useCallback(() => {
    terminalManager.clearFuzzyHighlights(tabId);
    setMatches([]);
    setActiveIndex(0);
    setState((p) => ({ ...p, open: false, matchCount: 0, currentMatch: 0 }));
  }, [tabId]);

  const setQuery = useCallback(
    (query: string) => {
      setState((p) => ({ ...p, query }));
      recompute(query, state.ignoreCase);
    },
    [recompute, state.ignoreCase],
  );

  const setReplaceValue = useCallback((replaceValue: string) => {
    setState((p) => ({ ...p, replaceValue }));
  }, []);

  const setIgnoreCase = useCallback(
    (ignoreCase: boolean) => {
      setState((p) => ({ ...p, ignoreCase }));
      recompute(state.query, ignoreCase);
    },
    [recompute, state.query],
  );

  const goTo = useCallback(
    (direction: "next" | "previous") => {
      if (matches.length === 0) {
        return;
      }
      const index =
        direction === "next"
          ? (activeIndex + 1) % matches.length
          : (activeIndex - 1 + matches.length) % matches.length;
      setActiveIndex(index);
      setState((p) => ({ ...p, currentMatch: index + 1 }));
      terminalManager.setFuzzyHighlights(tabId, matches, index);
      const match = matches[index];
      if (match) {
        terminalManager.scrollToBufferRow(tabId, match.row);
      }
    },
    [tabId, matches, activeIndex],
  );

  const findNext = useCallback(() => goTo("next"), [goTo]);
  const findPrevious = useCallback(() => goTo("previous"), [goTo]);

  const replaceOne = useCallback(() => {
    const current = terminalManager.getPendingInputLine(tabId);
    const next = replaceFirstFuzzy(current, state.query, state.replaceValue, state.ignoreCase);
    terminalManager.replaceInPendingInput(tabId, next);
  }, [tabId, state.query, state.replaceValue, state.ignoreCase]);

  const replaceAll = useCallback(() => {
    const current = terminalManager.getPendingInputLine(tabId);
    const next = replaceAllFuzzy(current, state.query, state.replaceValue, state.ignoreCase);
    terminalManager.replaceInPendingInput(tabId, next);
  }, [tabId, state.query, state.replaceValue, state.ignoreCase]);

  return {
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
  };
}
