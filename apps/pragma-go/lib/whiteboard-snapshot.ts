import { bytesToBase64, type WhiteboardsClient } from "@pragma-sh/sdk";

/** Read-only whiteboard payload consumed by the scratchpad viewer. */
export interface ScratchpadWhiteboardSnapshot {
  id: string;
  title: string;
  version: number;
  dataUrl: string;
}

/** Loads a changed whiteboard as a PNG while enforcing scratchpad worktree isolation. */
export async function getWhiteboardSnapshot(
  client: Pick<WhiteboardsClient, "get" | "view">,
  worktreeId: string,
  id: string,
  knownVersion?: number,
  dark = false,
): Promise<ScratchpadWhiteboardSnapshot | null> {
  const board = await client.get({ worktreeId, id });
  if (board.worktreeId !== worktreeId) {
    throw new Error("Whiteboard belongs to another worktree");
  }
  if (board.version === knownVersion) return null;
  const png = await client.view({ worktreeId, id, dark });
  return {
    id: board.id,
    title: board.title,
    version: board.version,
    dataUrl: `data:image/png;base64,${bytesToBase64(png)}`,
  };
}
