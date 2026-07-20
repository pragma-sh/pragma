import { useCallback, useEffect, useState } from "react";

import {
  browserFindClear,
  browserFindSeek,
  browserFindSet,
  onBrowserFindRequest,
} from "@/lib/tauri";

export interface BrowserFindState {
  open: boolean;
  query: string;
  ignoreCase: boolean;
  matchCount: number;
  currentMatch: number;
}

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

  const setQuery = useCallback(
    (query: string) => {
      setState((p) => ({ ...p, query }));
      if (!query) {
        void browserFindClear(tabId);
        setState((p) => ({ ...p, matchCount: 0, currentMatch: 0 }));
        return;
      }
      void browserFindSet(tabId, query, !state.ignoreCase).then(({ count, index }) => {
        setState((p) => ({ ...p, matchCount: count, currentMatch: index + 1 }));
        return undefined;
      });
    },
    [tabId, state.ignoreCase],
  );

  const setIgnoreCase = useCallback(
    (ignoreCase: boolean) => {
      setState((p) => ({ ...p, ignoreCase }));
      if (!state.query) {
        return;
      }
      void browserFindSet(tabId, state.query, !ignoreCase).then(({ count, index }) => {
        setState((p) => ({ ...p, matchCount: count, currentMatch: index + 1 }));
        return undefined;
      });
    },
    [tabId, state.query],
  );

  const openBar = useCallback(() => setState((p) => ({ ...p, open: true })), []);

  const closeBar = useCallback(() => {
    void browserFindClear(tabId);
    setState((p) => ({ ...p, open: false, matchCount: 0, currentMatch: 0 }));
  }, [tabId]);

  const findNext = useCallback(() => {
    if (!state.query) {
      return;
    }
    void browserFindSeek(tabId, true).then(({ count, index }) => {
      setState((p) => ({ ...p, matchCount: count, currentMatch: index + 1 }));
      return undefined;
    });
  }, [tabId, state.query]);

  const findPrevious = useCallback(() => {
    if (!state.query) {
      return;
    }
    void browserFindSeek(tabId, false).then(({ count, index }) => {
      setState((p) => ({ ...p, matchCount: count, currentMatch: index + 1 }));
      return undefined;
    });
  }, [tabId, state.query]);

  return { ...state, openBar, closeBar, setQuery, setIgnoreCase, findNext, findPrevious };
}
