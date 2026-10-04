import { useSyncExternalStore } from "react";

/**
 * A worktree's unfinished pull-request form, persisted per device outside git
 * so commits cannot reset it. `drafted` marks a form the AI filled in: the
 * sidebar reports that worktree as ready for a PR until the PR is opened or
 * the form is emptied. A title typed (or defaulted) by hand does not set it.
 */
export interface PullRequestDraft {
  title: string;
  body: string;
  drafted: boolean;
}

const STORAGE_PREFIX = "pragma:pull-request-draft:";
const EMPTY_DRAFT: PullRequestDraft = { title: "", body: "", drafted: false };
const listeners = new Set<() => void>();

function storageKey(worktreeId: string): string {
  return `${STORAGE_PREFIX}${worktreeId}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(worktreeId: string, draft: PullRequestDraft): void {
  try {
    if (!draft.title && !draft.body) {
      window.localStorage.removeItem(storageKey(worktreeId));
    } else {
      window.localStorage.setItem(storageKey(worktreeId), JSON.stringify(draft));
    }
  } catch {
    // Draft persistence must not prevent editing when localStorage is unavailable.
  }
  notify();
}

/** Reads a worktree's unfinished PR form, ignoring unavailable or malformed storage. */
export function readPullRequestDraft(worktreeId: string): PullRequestDraft {
  try {
    const raw = window.localStorage.getItem(storageKey(worktreeId));
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<PullRequestDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      drafted: parsed.drafted === true,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

/** Saves the form as edited, keeping whether the AI drafted it. Empty clears it. */
export function savePullRequestDraft(
  worktreeId: string,
  form: { title: string; body: string },
): void {
  write(worktreeId, { ...form, drafted: readPullRequestDraft(worktreeId).drafted });
}

/** Stores an AI-generated draft, marking the worktree ready for a PR. */
export function storeGeneratedPullRequestDraft(
  worktreeId: string,
  draft: { title: string; body: string },
): void {
  write(worktreeId, { title: draft.title, body: draft.body, drafted: true });
}

/** Removes a worktree's saved form after its PR has been opened successfully. */
export function clearPullRequestDraft(worktreeId: string): void {
  write(worktreeId, EMPTY_DRAFT);
}

/** Whether an AI-drafted PR is waiting to be opened for this worktree. */
export function usePullRequestDrafted(worktreeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readPullRequestDraft(worktreeId).drafted,
    () => false,
  );
}
