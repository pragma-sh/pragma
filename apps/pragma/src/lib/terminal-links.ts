import type { IBufferCell, ILink, Terminal } from "@xterm/xterm";

/**
 * Bridge from the non-React {@link TerminalManager} to the workspace actions that
 * open terminal links. The handler is registered once by the workspace context
 * (the only place that can create tabs / splits) and read by every terminal's
 * link providers. It is `null` until the provider mounts.
 *
 * `openUrl`/`openFile` receive the clicked terminal's tab + worktree so the
 * resource can open in a split to the right of *that* terminal. `pathExists`
 * gates the file-path link provider so only real files are decorated as links.
 */
export interface TerminalLinkHandler {
  /** Opens a URL: in a browser split to the right, or the system browser. */
  openUrl(args: { tabId: string; worktreeId: string; url: string; external: boolean }): void;
  /** Opens a worktree-relative file path in an editor split to the right. */
  openFile(args: { tabId: string; worktreeId: string; path: string }): void;
  /** Resolves whether a worktree-relative path exists (errors resolve to false). */
  pathExists(worktreeId: string, path: string): Promise<boolean>;
}

let terminalLinkHandler: TerminalLinkHandler | null = null;

/** Registers the workspace-backed handler used by every terminal's link providers. */
export function setTerminalLinkHandler(handler: TerminalLinkHandler | null): void {
  terminalLinkHandler = handler;
}

/** Returns the active terminal link handler, or `null` before one is registered. */
export function getTerminalLinkHandler(): TerminalLinkHandler | null {
  return terminalLinkHandler;
}

/** A file-path token found within a single terminal line, in char-index space. */
export interface FilePathCandidate {
  /** Inclusive start char index into the line string. */
  start: number;
  /** Exclusive end char index (covers the path, excluding any `:line:col`). */
  end: number;
  /** The path text (without a trailing `:line` / `:line:col` locator). */
  path: string;
}

const WRAPPING_LEAD = /^[([{<'"`]+/;
const WRAPPING_TRAIL = /[)\]}>'"`.,;:]+$/;
const LINE_LOCATOR = /:\d+(?::\d+)?$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * Finds file-path-like tokens in a single line of terminal text. A token must
 * either contain a path separator (`/`) or end in a file extension to qualify,
 * so plain words and numbers are ignored. Wrapping brackets/quotes and a
 * trailing `:line:col` locator are stripped; URLs (`scheme://…`) are left to the
 * web-links provider. Returned indices are into `text`; callers map them to
 * terminal columns and must still verify the path exists before linkifying.
 */
export function findFilePathCandidates(text: string): FilePathCandidate[] {
  const candidates: FilePathCandidate[] = [];
  const token = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    let raw = match[0];
    let start = match.index;
    const lead = WRAPPING_LEAD.exec(raw);
    if (lead) {
      start += lead[0].length;
      raw = raw.slice(lead[0].length);
    }
    const trail = WRAPPING_TRAIL.exec(raw);
    if (trail) {
      raw = raw.slice(0, raw.length - trail[0].length);
    }
    if (!raw || raw.includes("://")) {
      continue;
    }
    let path = raw;
    const locator = LINE_LOCATOR.exec(raw);
    if (locator) {
      path = raw.slice(0, locator.index);
    }
    if (path === "" || path === "/" || path === "." || path === "..") {
      continue;
    }
    if (!path.includes("/") && !HAS_EXTENSION.test(path)) {
      continue;
    }
    candidates.push({ start, end: start + path.length, path });
  }
  return candidates;
}

/**
 * Resolves a path printed in a terminal to a worktree-relative path, or `null`
 * if it falls outside the worktree. Absolute paths must live under `cwd` (the
 * worktree root); relative paths are taken as relative to it. Paths escaping the
 * worktree (via `..` or an unrelated absolute root) are rejected so they never
 * cross the path-safe `fs` IPC boundary.
 */
export function toWorktreeRelativePath(path: string, cwd: string): string | null {
  let relative: string;
  if (path.startsWith("/")) {
    if (!cwd.startsWith("/")) {
      return null;
    }
    const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
    if (path === root) {
      return null;
    }
    if (!path.startsWith(`${root}/`)) {
      return null;
    }
    relative = path.slice(root.length + 1);
  } else {
    relative = path.replace(/^\.\//, "");
  }
  if (relative === "" || relative.split("/").includes("..")) {
    return null;
  }
  return relative;
}

/**
 * Builds the char-index → 0-based column map for a terminal line. Iterating
 * cells (rather than trusting string offsets) keeps the mapping accurate when a
 * line contains wide (CJK/emoji) glyphs that occupy two columns.
 */
function readLineColumns(
  terminal: Terminal,
  bufferLineNumber: number,
): { text: string; columnOf: number[] } | null {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) {
    return null;
  }
  const cell: IBufferCell = terminal.buffer.active.getNullCell();
  let text = "";
  const columnOf: number[] = [];
  for (let column = 0; column < line.length; column++) {
    line.getCell(column, cell);
    if (cell.getWidth() === 0) {
      // The trailing cell of a wide glyph carries no chars; skip it so the
      // preceding glyph keeps a single, correct column.
      continue;
    }
    const chars = cell.getChars() || " ";
    for (const char of chars) {
      text += char;
      columnOf.push(column);
    }
  }
  return { text, columnOf };
}

/**
 * A link provider that decorates existing worktree files printed in the terminal
 * (e.g. compiler/test output, `ls`, grep) and opens them on click via the
 * registered {@link TerminalLinkHandler}. Candidate paths are verified against
 * the worktree before being linkified, so arbitrary path-shaped text is left
 * alone. Like URL links, activation requires **Shift+click** — the deliberate
 * "open this" gesture, which also bypasses a TUI's mouse tracking; a plain click
 * is left to xterm for selection.
 */
export function createFileLinkProvider(
  terminal: Terminal,
  tabId: string,
  worktreeId: string,
  cwd: string,
) {
  async function resolveLinks(bufferLineNumber: number): Promise<ILink[] | undefined> {
    const handler = getTerminalLinkHandler();
    if (!handler) {
      return undefined;
    }
    const mapped = readLineColumns(terminal, bufferLineNumber);
    if (!mapped) {
      return undefined;
    }
    const { text, columnOf } = mapped;
    const maybeLinks = await Promise.all(
      findFilePathCandidates(text).map(async (candidate): Promise<ILink | null> => {
        const relative = toWorktreeRelativePath(candidate.path, cwd);
        if (!relative) {
          return null;
        }
        const startColumn = columnOf[candidate.start];
        const endColumn = columnOf[candidate.end - 1];
        if (startColumn === undefined || endColumn === undefined) {
          return null;
        }
        if (!(await handler.pathExists(worktreeId, relative))) {
          return null;
        }
        return {
          text: text.slice(candidate.start, candidate.end),
          range: {
            start: { x: startColumn + 1, y: bufferLineNumber },
            end: { x: endColumn + 1, y: bufferLineNumber },
          },
          activate: (event) => {
            if (!event.shiftKey) {
              return;
            }
            handler.openFile({ tabId, worktreeId, path: relative });
          },
        };
      }),
    );
    const links = maybeLinks.filter((link): link is ILink => link !== null);
    return links.length > 0 ? links : undefined;
  }

  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      void (async () => {
        try {
          callback(await resolveLinks(bufferLineNumber));
        } catch {
          callback(undefined);
        }
      })();
    },
  };
}
