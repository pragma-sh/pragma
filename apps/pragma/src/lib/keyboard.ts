import type { KeyboardEvent } from "react";

/**
 * Returns an `onKeyDown` handler that commits on Enter and cancels on Escape,
 * calling `preventDefault` for both. Shared by the app's inline-edit inputs
 * (tab rename, worktree rename, new/rename file-tree entries).
 */
export function commitOnEnterCancelOnEscape(
  commit: () => void,
  cancel: () => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };
}
