import { useLocalSearchParams } from "expo-router";

import { CodeScreen } from "@/components/code/CodeScreen";
import { fileName, fileView } from "@/lib/code-content";
import { useWorktreeRead } from "@/lib/use-worktree-read";

/**
 * One file in a worktree, read-only, as the host has it on disk now.
 *
 * Read through the host's filesystem RPC, which confines `path` to the
 * worktree and caps how much it will send; a binary or oversized file is
 * reported as such rather than rendered as garbage.
 */
export default function FileScreen() {
  const { worktreeId, path } = useLocalSearchParams<{ worktreeId: string; path: string }>();
  const file = useWorktreeRead(worktreeId, path, (client, root) =>
    client.fs.readFile({ root, path }),
  );
  return (
    <CodeScreen
      error={file.error}
      loading={file.loading}
      onRetry={file.reload}
      subtitle={path}
      title={fileName(path)}
      view={fileView(file.value, path)}
    />
  );
}
