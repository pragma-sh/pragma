/**
 * Pure forward-slash path helpers for worktree-relative paths. These never touch
 * the Node `path` module (it isn't in the browser bundle) and always operate on
 * POSIX-style strings, which is the canonical wire format for fs/git commands.
 */

/** Returns the final path segment (file or directory name). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Returns the lower-case extension without its dot, or "" when there is none.
 * A leading dot names the file (`.gitignore`), so it is not an extension.
 */
export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

/** Returns the parent directory of a path, or "" for a top-level entry. */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "" : trimmed.slice(0, index);
}

/** Joins segments with single slashes, dropping empty/leading/trailing slashes. */
export function joinPath(...segments: string[]): string {
  return segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("/");
}
