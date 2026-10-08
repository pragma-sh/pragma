import type { DirEntry } from "@pragma-sh/constants";

// Pure model of the worktree file explorer, kept beside the component so the
// flattening — the only part with real logic — is tested without React.

/** One directory's listing as far as it has loaded. */
export type DirListing =
  | { kind: "loading" }
  | { kind: "ready"; entries: DirEntry[] }
  | { kind: "error"; message: string };

/** One visible line of the explorer. */
export type FileTreeRow =
  | { kind: "entry"; entry: DirEntry; depth: number; expanded: boolean }
  /** A placeholder under an expanded folder whose listing is not usable yet. */
  | { kind: "status"; key: string; depth: number; text: string };

/** The worktree root's path in the host's filesystem RPC. */
export const ROOT_PATH = "";

/**
 * Flattens the expanded tree into the rows a list renders, depth-first in the
 * host's order (folders first, then case-insensitive by name).
 *
 * A collapsed folder hides everything beneath it even when its listing is
 * cached, so re-expanding is instant; an expanded folder still loading or
 * failed shows one status line instead of pretending to be empty.
 */
export function visibleFileRows(
  listings: ReadonlyMap<string, DirListing>,
  expanded: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const walk = (path: string, depth: number): void => {
    const listing = listings.get(path) ?? { kind: "loading" };
    if (listing.kind !== "ready") {
      const text = listing.kind === "loading" ? "Loading…" : listing.message;
      rows.push({ kind: "status", key: `${path}:status`, depth, text });
      return;
    }
    if (listing.entries.length === 0) {
      rows.push({ kind: "status", key: `${path}:empty`, depth, text: "Empty" });
      return;
    }
    for (const entry of listing.entries) {
      const open = entry.isDir && expanded.has(entry.path);
      rows.push({ kind: "entry", entry, depth, expanded: open });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_PATH, 0);
  return rows;
}

/** Toggles a folder in the expanded set, returning a new set. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
