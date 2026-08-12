import type { FileDiff } from "@pragma/constants";
import { useEffect, useState } from "react";

import { UnifiedDiff } from "@/components/editor/UnifiedDiff";
import { baseFileDiff } from "@/lib/tauri";

/**
 * One base-to-attempt diff cell.
 *
 * Loads on mount, which is what makes the section's lazy expansion worth
 * having: the parent only mounts a cell while its file row is expanded, so a
 * five-way fanout over a hundred changed files does not build a thousand
 * editors to show a collapsed list.
 *
 * Renders a {@link UnifiedDiff}: only the changed lines, red for deletions and
 * green for insertions, compared against the base — no side-by-side old/new
 * pane and no unchanged context.
 */
export function FanoutDiffCell({
  worktreeId,
  base,
  path,
}: {
  worktreeId: string;
  base: string;
  path: string;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    void baseFileDiff(worktreeId, base, path)
      .then((loaded) => {
        if (!cancelled) setDiff(loaded);
        return loaded;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, base, path]);

  if (error) {
    return <p className="p-2 text-xs text-destructive">{error}</p>;
  }
  if (!diff) {
    return <p className="p-2 text-xs text-muted-foreground">Loading diff…</p>;
  }
  if (diff.binary) {
    return <p className="p-2 text-xs text-muted-foreground">Binary file</p>;
  }
  return <UnifiedDiff fileName={path} newText={diff.newText} oldText={diff.oldText} />;
}
