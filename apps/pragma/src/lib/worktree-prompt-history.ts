import { splitPromptContext } from "@pragma-sh/plugin/catalog";

import type { AgentModelSelection } from "@/lib/tauri";

const STORAGE_PREFIX = "pragma:worktree-prompt-history:";

/** Most entries kept per project; the oldest fall off first. */
const MAX_ENTRIES = 30;

/** One attempt's agent and model, as submitted. */
export interface PromptHistoryAgent {
  agentId: string | null;
  selection: AgentModelSelection;
}

/**
 * One submitted run from the create-worktree dialog: enough to fill the form
 * back out exactly as it was sent.
 */
export interface PromptHistoryEntry {
  id: string;
  /** Epoch milliseconds. */
  submittedAt: number;
  mode: "single" | "fanout";
  branch: string;
  title: string;
  /** The submitted prompt, `@` context blocks included (split again on restore). */
  prompt: string;
  /** One entry in single mode; every attempt row in fanout mode. */
  agents: PromptHistoryAgent[];
}

/** Reads a project's submitted runs, newest first. Corrupt storage reads as empty. */
export function readPromptHistory(projectId: string): PromptHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PromptHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Records a submitted run at the front of the project's history. */
export function recordPromptHistory(
  projectId: string,
  entry: Omit<PromptHistoryEntry, "id" | "submittedAt">,
): void {
  const next: PromptHistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    submittedAt: Date.now(),
  };
  const entries = [next, ...readPromptHistory(projectId)].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(entries));
  } catch {
    // Convenience only; a full or unavailable localStorage must not block creation.
  }
}

/** The entry's heading: its display title, falling back to the branch name. */
export function promptHistoryLabel(entry: PromptHistoryEntry): string {
  return entry.title.trim() || entry.branch;
}

/** The first sentence of the entry's prompt, without its attached `@` context. */
export function promptHistorySummary(entry: PromptHistoryEntry): string {
  const text = splitPromptContext(entry.prompt).prompt.trim().replace(/\s+/g, " ");
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  return match ? match[0] : text;
}
