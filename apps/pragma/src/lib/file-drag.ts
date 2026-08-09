import type { DragEvent } from "react";

/** Custom MIME type carrying the worktree-relative paths of an in-app drag. */
export const PRAGMA_PATHS_MIME = "application/x-pragma-paths";

/**
 * The paths of the drag currently in flight. WebKit (the macOS and Linux webview)
 * hands back an empty string from `getData` for custom MIME types often enough that
 * the wire payload alone cannot be trusted, so the source also parks them here.
 */
let draggedPaths: string[] | null = null;

/** Marks a drag as carrying tree paths: on the dataTransfer and in module state. */
export function beginPathDrag(event: DragEvent<HTMLElement>, paths: string[]): void {
  draggedPaths = paths;
  const payload = JSON.stringify(paths);
  event.dataTransfer.setData(PRAGMA_PATHS_MIME, payload);
  // text/plain is the one type every engine round-trips, so it is the fallback.
  event.dataTransfer.setData("text/plain", payload);
  event.dataTransfer.effectAllowed = "move";
}

/** Clears the in-flight drag once it ends, dropped or cancelled. */
export function endPathDrag(): void {
  draggedPaths = null;
}

/** True while an in-app path drag is in flight (readable during dragover, unlike the data). */
export function isPathDragActive(): boolean {
  return draggedPaths !== null;
}

function parsePaths(value: string): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Reads the dragged paths from a drop, falling back through text/plain to module state. */
export function readDraggedPaths(event: DragEvent<HTMLElement>): string[] | null {
  return (
    parsePaths(event.dataTransfer.getData(PRAGMA_PATHS_MIME)) ??
    parsePaths(event.dataTransfer.getData("text/plain")) ??
    draggedPaths
  );
}
