import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

/** State shared by every find bar, replace-capable or not. */
export interface FindBarState {
  open: boolean;
  query: string;
  ignoreCase: boolean;
  matchCount: number;
  currentMatch: number;
}

/** State for a find bar that also supports replace (editor, markdown, terminal). */
export interface FindReplaceState extends FindBarState {
  replaceValue: string;
}

/** API shared by every replace-capable find hook (editor, markdown, terminal). */
export interface FindReplaceApi extends FindReplaceState {
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

/** Every find bar's `openBar` is the same: flip `open` true, no recompute needed. */
export function useOpenBar<S extends FindBarState>(
  setState: Dispatch<SetStateAction<S>>,
): () => void {
  return useCallback(() => setState((previous) => ({ ...previous, open: true })), [setState]);
}

/** Shared `setQuery`: store the query, then re-run the surface-specific match recompute. */
export function useSetQuery<S extends FindBarState>(
  setState: Dispatch<SetStateAction<S>>,
  recompute: (query: string, ignoreCase: boolean) => void,
  ignoreCase: boolean,
): (value: string) => void {
  return useCallback(
    (query: string) => {
      setState((previous) => ({ ...previous, query }));
      recompute(query, ignoreCase);
    },
    [setState, recompute, ignoreCase],
  );
}

/** Shared `setIgnoreCase`: store the flag, then re-run the surface-specific match recompute. */
export function useSetIgnoreCase<S extends FindBarState>(
  setState: Dispatch<SetStateAction<S>>,
  recompute: (query: string, ignoreCase: boolean) => void,
  query: string,
): (value: boolean) => void {
  return useCallback(
    (ignoreCase: boolean) => {
      setState((previous) => ({ ...previous, ignoreCase }));
      recompute(query, ignoreCase);
    },
    [setState, recompute, query],
  );
}

/** Shared `setReplaceValue`: a plain field update, no recompute needed. */
export function useSetReplaceValue<S extends FindReplaceState>(
  setState: Dispatch<SetStateAction<S>>,
): (value: string) => void {
  return useCallback(
    (replaceValue: string) => setState((previous) => ({ ...previous, replaceValue })),
    [setState],
  );
}
