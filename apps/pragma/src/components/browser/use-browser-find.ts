import { useCallback, useEffect, useState } from "react";

import {
  browserFindClear,
  browserFindSeek,
  browserFindSet,
  onBrowserFindRequest,
} from "@/lib/tauri";
import { type FindBarState, useOpenBar } from "@/components/find-replace/find-replace-state";

export type BrowserFindState = FindBarState;

export interface BrowserFindApi extends BrowserFindState {
  openBar: () => void;
  closeBar: () => void;
  setQuery: (value: string) => void;
  setIgnoreCase: (value: boolean) => void;
  findNext: () => void;
  findPrevious: () => void;
}

/** Drives find-only (no replace — page content isn't user-editable) for one browser tab. */
export function useBrowserFind(tabId: string): BrowserFindApi {
  const [state, setState] = useState<BrowserFindState>({
    open: false,
    query: "",
    ignoreCase: false,
    matchCount: 0,
    currentMatch: 0,
  });
  useEffect(
    () =>
      void onBrowserFindRequest((request) => {
        if (request.tabId === tabId) {
          setState((p) => ({ ...p, open: true }));
        }
      }).then((unlisten) => unlisten),
    [tabId],
  );

  const applyMatchResult = useCallback(({ count, index }: { count: number; index: number }) => {
    setState((p) => ({ ...p, matchCount: count, currentMatch: index + 1 }));
  }, []);

  const setQuery = useCallback(
    (query: string) => {
      setState((p) => ({ ...p, query }));
      if (!query) {
        void browserFindClear(tabId);
        setState((p) => ({ ...p, matchCount: 0, currentMatch: 0 }));
        return;
      }
      void browserFindSet(tabId, query, !state.ignoreCase).then(applyMatchResult);
    },
    [tabId, state.ignoreCase, applyMatchResult],
  );

  const setIgnoreCase = useCallback(
    (ignoreCase: boolean) => {
      setState((p) => ({ ...p, ignoreCase }));
      if (!state.query) {
        return;
      }
      void browserFindSet(tabId, state.query, !ignoreCase).then(applyMatchResult);
    },
    [tabId, state.query, applyMatchResult],
  );

  const openBar = useOpenBar(setState);

  const closeBar = useCallback(() => {
    void browserFindClear(tabId);
    setState((p) => ({ ...p, open: false, matchCount: 0, currentMatch: 0 }));
  }, [tabId]);

  const findNext = useCallback(() => {
    if (!state.query) {
      return;
    }
    void browserFindSeek(tabId, true).then(applyMatchResult);
  }, [tabId, state.query, applyMatchResult]);

  const findPrevious = useCallback(() => {
    if (!state.query) {
      return;
    }
    void browserFindSeek(tabId, false).then(applyMatchResult);
  }, [tabId, state.query, applyMatchResult]);

  return { ...state, openBar, closeBar, setQuery, setIgnoreCase, findNext, findPrevious };
}
