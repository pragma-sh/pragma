import { constants } from "@pragma-sh/constants";

/**
 * Pragma Mini: lightweight terminal windows next to the main workspace. The
 * values come from `constants.miniWindow`, shared with `src-tauri/src/mini_window.rs`.
 */
const MINI = constants.miniWindow;

/** Sentinel worktree id of a mini tab that is not in a project (local home directory). */
export const MINI_HOME_WORKTREE_ID = MINI.homeWorktreeId;

/** Whether a Tauri window label belongs to a Pragma Mini window. */
export function isMiniWindowLabel(label: string): boolean {
  return label.startsWith(MINI.labelPrefix);
}

/** Whether a PTY session / tab id belongs to a Pragma Mini tab. */
export function isMiniSessionId(id: string): boolean {
  return id.startsWith(MINI.sessionIdPrefix);
}

/** A fresh session id for a mini tab (also its terminal key). */
export function newMiniSessionId(): string {
  return `${MINI.sessionIdPrefix}${crypto.randomUUID()}`;
}
