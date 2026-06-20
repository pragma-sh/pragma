import { useEffect, useState } from "react";

import type { Tab } from "@pragma/constants";

import { MergeDiff } from "@/components/editor/MergeDiff";
import { fileDiff } from "@/lib/tauri";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; oldText: string; newText: string }
  | { kind: "binary" }
  | { kind: "error"; message: string };

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Read-only side-by-side diff for `diff` tabs, backed by `@codemirror/merge`.
 * Loads the old/new text via the worktree-scoped `file_diff` command (keyed on
 * the tab id) and recomputes it live each time the tab opens. The file's
 * language grammar is resolved lazily so both panes get syntax highlighting.
 */
export function DiffView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath, diffSide } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!filePath || !diffSide) {
      setState({ kind: "error", message: "This diff tab is missing its file path." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    // `oldPath` (for renames) isn't persisted on the tab, so committed renames
    // fall back to diffing against the current path — a benign degradation.
    void (async () => {
      try {
        const diff = await fileDiff(worktreeId, filePath, diffSide);
        if (cancelled) {
          return;
        }
        if (diff.binary) {
          setState({ kind: "binary" });
          return;
        }
        setState({ kind: "ready", oldText: diff.oldText, newText: diff.newText });
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: messageFor(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, worktreeId, filePath, diffSide]);

  if (state.kind === "binary") {
    return <Placeholder>This file is binary and can't be diffed.</Placeholder>;
  }
  if (state.kind === "error") {
    return <Placeholder>{state.message}</Placeholder>;
  }
  if (state.kind === "loading") {
    return <Placeholder>Loading diff…</Placeholder>;
  }

  return (
    <MergeDiff fileName={filePath ?? undefined} newText={state.newText} oldText={state.oldText} />
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#0b0d10] p-6 text-center text-sm text-slate-400">
      {children}
    </div>
  );
}
