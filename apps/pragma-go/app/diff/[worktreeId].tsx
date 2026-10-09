import { useLocalSearchParams } from "expo-router";

import { CodeScreen } from "@/components/code/CodeScreen";
import { diffView, fileName } from "@/lib/code-content";
import { useWorktreeRead } from "@/lib/use-worktree-read";

/**
 * One file's changes in a worktree against an exact base commit, read-only:
 * only the changed lines, red for removed and green for added, as the desktop's
 * fanout comparison shows them. The new side is the file on disk, so an
 * attempt's uncommitted work is included.
 */
export default function DiffScreen() {
  const { worktreeId, path, base, oldPath, label } = useLocalSearchParams<{
    worktreeId: string;
    path: string;
    base: string;
    oldPath?: string;
    label?: string;
  }>();
  const diff = useWorktreeRead(worktreeId, `${base}\0${path}`, (client, root) =>
    client.git.baseFileDiff({ root, base, path, oldPath: oldPath || null }),
  );
  return (
    <CodeScreen
      error={diff.error}
      loading={diff.loading}
      onRetry={diff.reload}
      subtitle={label ? `${label} · ${path}` : path}
      title={fileName(path)}
      view={diffView(diff.value, path)}
    />
  );
}
