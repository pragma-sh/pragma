import { constants } from "@pragma-sh/constants";

import { fileBase64, isPathDragActive, readDraggedPaths } from "@/lib/file-drag";
import { saveDroppedFile } from "@/lib/tauri";

/**
 * How a pasted path must be quoted for the shell reading it. `cmd.exe` needs
 * its own style: it has no escape for an embedded quote, and treats a
 * PowerShell-style single-quoted string as literal, unsplit text — a quoted
 * path with a space would paste as one unusable argument.
 */
export type ShellQuoteStyle = "posix" | "powershell" | "cmd";

/** Where a terminal drop lands: the worktree whose host owns the PTY, and its root. */
export interface TerminalDropTarget {
  worktreeId: string;
  /** Absolute worktree root; in-app file-tree paths are relative to it. */
  root: string;
  /**
   * Resolved lazily (it may need a config read) but requested up front, in
   * parallel with copying any dropped files to the PTY host.
   */
  quoteStyle: Promise<ShellQuoteStyle>;
}

// Characters that never need escaping in a POSIX shell word.
const POSIX_SAFE = /^[\w@%+=:,./~-]+$/;

/**
 * Quotes one path for pasting at a shell prompt. POSIX paths are
 * backslash-escaped the way Terminal.app and iTerm2 paste a dropped file, which
 * image-aware agent TUIs recognise; control characters cannot be escaped that
 * way, so those fall back to single quotes. `cmd.exe` has no escape for a
 * double quote at all, so one is simply dropped rather than allowed to end the
 * quoted string early — mirrors `pragma_platform::shell::quote_cmd`.
 */
export function quoteShellPath(path: string, style: ShellQuoteStyle): string {
  if (style === "cmd") {
    return POSIX_SAFE.test(path) ? path : `"${path.replaceAll('"', "")}"`;
  }
  if (style === "powershell") {
    return POSIX_SAFE.test(path) ? path : `'${path.replaceAll("'", "''")}'`;
  }
  if (POSIX_SAFE.test(path)) {
    return path;
  }
  // oxlint-disable-next-line no-control-regex -- detecting control characters is the point.
  if (/[\x00-\x1f\x7f]/.test(path)) {
    return `'${path.replaceAll("'", "'\\''")}'`;
  }
  return path.replace(/[^\w@%+=:,./~-]/g, (char) => `\\${char}`);
}

/** Whether a drag carries something a terminal can accept (files, tree paths, or text). */
export function isTerminalDrop(transfer: DataTransfer | null): boolean {
  if (isPathDragActive()) {
    return true;
  }
  const types = transfer ? [...transfer.types] : [];
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
}

/** Joins a worktree-relative path onto the absolute worktree root. */
function absoluteTreePath(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

/**
 * Resolves a drop into the text to paste into the terminal: space-separated,
 * shell-quoted absolute paths followed by a trailing space (matching native
 * terminals), or the dragged text verbatim. Dropped files are copied to the
 * PTY's host first, because the webview never exposes a file's real path and
 * a remote shell could not open it anyway. Resolves null when nothing usable
 * was dropped.
 */
export async function resolveTerminalDrop(
  transfer: DataTransfer | null,
  target: TerminalDropTarget,
): Promise<string | null> {
  // Every read of `transfer` happens here, synchronously, before any `await` —
  // the browser can invalidate a drop event's DataTransfer once its handler's
  // synchronous portion returns.
  const treePaths = isPathDragActive() ? readDraggedPaths({ dataTransfer: transfer }) : null;
  const files = transfer ? [...transfer.files] : [];
  const text = transfer?.getData("text/plain") || transfer?.getData("text/uri-list") || "";

  if (treePaths && treePaths.length > 0) {
    return joinQuoted(
      treePaths.map((path) => absoluteTreePath(target.root, path)),
      await target.quoteStyle,
    );
  }
  if (files.length > 0) {
    const maxBytes = constants.terminalDefaults.maxDroppedFileBytes;
    const oversized = files.find((file) => file.size > maxBytes);
    if (oversized) {
      throw new Error(
        `${oversized.name} is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MiB terminal drop limit`,
      );
    }
    const [paths, quoteStyle] = await Promise.all([
      Promise.all(
        files.map(async (file) =>
          saveDroppedFile(target.worktreeId, file.name, await fileBase64(file)),
        ),
      ),
      target.quoteStyle,
    ]);
    return joinQuoted(paths, quoteStyle);
  }
  return text.length > 0 ? text : null;
}

function joinQuoted(paths: string[], style: ShellQuoteStyle): string {
  return `${paths.map((path) => quoteShellPath(path, style)).join(" ")} `;
}
