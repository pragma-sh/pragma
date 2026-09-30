/**
 * Parse and resolve git conflict markers in one file.
 *
 * Handles both the default `merge` style and `diff3`/`zdiff3` (which add a
 * `|||||||` section holding the merge-base text). Line endings are preserved
 * byte for byte: every side keeps the endings git wrote, so a resolved file
 * differs from the conflicted one only inside the conflicts.
 */

/** How one conflict is resolved. `ours` is HEAD (the branch being merged into). */
export type ConflictChoice = "ours" | "theirs" | "both_ours_first" | "both_theirs_first";

/** Every choice, in the order they are offered. */
export const CONFLICT_CHOICES: readonly ConflictChoice[] = [
  "ours",
  "theirs",
  "both_ours_first",
  "both_theirs_first",
];

/** A resolution: one of the standard choices, or hand-written replacement text. */
export type ConflictResolution = { kind: ConflictChoice } | { kind: "custom"; content: string };

/** One `<<<<<<< … >>>>>>>` block. */
export interface ConflictHunk {
  /** Stable id within the file: `c1`, `c2`, … */
  id: string;
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-based line of the `>>>>>>>` marker. */
  endLine: number;
  ours: string;
  /** The merge-base text, present only in `diff3`/`zdiff3` style. */
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

/** A conflicted file split into untouched text and conflicts, in order. */
export interface ParsedConflictFile {
  segments: Array<{ kind: "text"; text: string } | { kind: "conflict"; hunk: ConflictHunk }>;
  hunks: ConflictHunk[];
  /** The file's lines with endings kept, for context excerpts. */
  lines: string[];
}

/** Raised when conflict markers are unbalanced or nested. */
export class MalformedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedConflictError";
  }
}

type Marker = "start" | "base" | "separator" | "end";

const MARKERS: ReadonlyArray<[Marker, string]> = [
  ["start", "<<<<<<<"],
  ["base", "|||||||"],
  ["separator", "======="],
  ["end", ">>>>>>>"],
];

/** Identifies a marker line and returns its label (text after the marker). */
function markerOf(line: string): { marker: Marker; label: string } | null {
  const text = line.replace(/\r?\n$/, "");
  for (const [marker, prefix] of MARKERS) {
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length);
    // Exactly seven characters, then end of line or a space — a longer run
    // (`========`) is content, not a marker.
    if (rest === "" || rest.startsWith(" ")) return { marker, label: rest.trim() };
  }
  return null;
}

/** Splits text into lines, each keeping its own line ending. */
function splitLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface OpenHunk {
  startLine: number;
  oursLabel: string;
  ours: string;
  base: string | null;
  theirs: string;
  section: "ours" | "base" | "theirs";
}

/** Adds one content line to whichever side of the open hunk is being read. */
function appendToHunk(open: OpenHunk, line: string): void {
  if (open.section === "ours") open.ours += line;
  else if (open.section === "base") open.base = (open.base ?? "") + line;
  else open.theirs += line;
}

/** Advances the open hunk on a marker line; returns the finished hunk on `>>>>>>>`. */
function applyMarker(
  open: OpenHunk,
  marker: Marker,
  label: string,
  lineNumber: number,
  id: string,
): ConflictHunk | null {
  if (marker === "start") {
    throw new MalformedConflictError(`nested conflict marker at line ${lineNumber}`);
  }
  if (marker === "base") {
    if (open.section !== "ours") {
      throw new MalformedConflictError(`unexpected ||||||| at line ${lineNumber}`);
    }
    open.section = "base";
    open.base = "";
    return null;
  }
  if (marker === "separator") {
    if (open.section === "theirs") {
      throw new MalformedConflictError(`unexpected ======= at line ${lineNumber}`);
    }
    open.section = "theirs";
    return null;
  }
  if (open.section !== "theirs") {
    throw new MalformedConflictError(`unexpected >>>>>>> at line ${lineNumber}`);
  }
  return {
    id,
    startLine: open.startLine,
    endLine: lineNumber,
    ours: open.ours,
    base: open.base,
    theirs: open.theirs,
    oursLabel: open.oursLabel,
    theirsLabel: label,
  };
}

/** Line-by-line parser state: untouched text so far, or the conflict being read. */
class ConflictParser {
  readonly segments: ParsedConflictFile["segments"] = [];
  readonly hunks: ConflictHunk[] = [];
  private text = "";
  private open: OpenHunk | null = null;

  feed(line: string, lineNumber: number): void {
    const found = markerOf(line);
    if (this.open === null) this.feedOutside(line, lineNumber, found);
    else this.feedInside(this.open, line, lineNumber, found);
  }

  /** Untouched text, until a `<<<<<<<` opens a conflict. */
  private feedOutside(line: string, lineNumber: number, found: ReturnType<typeof markerOf>): void {
    if (found?.marker !== "start") {
      this.text += line;
      return;
    }
    this.flushText();
    this.open = {
      startLine: lineNumber,
      oursLabel: found.label,
      ours: "",
      base: null,
      theirs: "",
      section: "ours",
    };
  }

  /** A side's content, or the marker that moves to the next section or closes the conflict. */
  private feedInside(
    open: OpenHunk,
    line: string,
    lineNumber: number,
    found: ReturnType<typeof markerOf>,
  ): void {
    if (!found) {
      appendToHunk(open, line);
      return;
    }
    const id = `c${this.hunks.length + 1}`;
    const hunk = applyMarker(open, found.marker, found.label, lineNumber, id);
    if (!hunk) return;
    this.hunks.push(hunk);
    this.segments.push({ kind: "conflict", hunk });
    this.open = null;
  }

  private flushText(): void {
    if (this.text) this.segments.push({ kind: "text", text: this.text });
    this.text = "";
  }

  finish(): void {
    if (this.open !== null) {
      throw new MalformedConflictError(
        `conflict starting at line ${this.open.startLine} never ends`,
      );
    }
    this.flushText();
  }
}

/**
 * Parses a conflicted file.
 *
 * @throws {MalformedConflictError} on nested, unbalanced, or unterminated markers.
 */
export function parseConflicts(content: string): ParsedConflictFile {
  const lines = splitLines(content);
  const parser = new ConflictParser();
  for (const [index, line] of lines.entries()) parser.feed(line, index + 1);
  parser.finish();
  return { segments: parser.segments, hunks: parser.hunks, lines };
}

/** Joins two sides, making sure the first ends on a line break. */
function joinSides(first: string, second: string): string {
  if (first === "" || first.endsWith("\n")) return first + second;
  return `${first}\n${second}`;
}

/** The text one resolution puts in place of its conflict. */
export function resolveHunk(hunk: ConflictHunk, resolution: ConflictResolution): string {
  switch (resolution.kind) {
    case "ours":
      return hunk.ours;
    case "theirs":
      return hunk.theirs;
    case "both_ours_first":
      return joinSides(hunk.ours, hunk.theirs);
    case "both_theirs_first":
      return joinSides(hunk.theirs, hunk.ours);
    case "custom":
      return resolution.content === "" || resolution.content.endsWith("\n")
        ? resolution.content
        : `${resolution.content}\n`;
  }
}

/**
 * Rebuilds the file with every conflict replaced by its resolution.
 *
 * @throws {Error} when a conflict has no resolution.
 */
export function applyResolutions(
  parsed: ParsedConflictFile,
  resolutions: ReadonlyMap<string, ConflictResolution>,
): string {
  return parsed.segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const resolution = resolutions.get(segment.hunk.id);
      if (!resolution) throw new Error(`conflict ${segment.hunk.id} has no resolution`);
      return resolveHunk(segment.hunk, resolution);
    })
    .join("");
}

/** Whether text still contains a conflict start or end marker line. */
export function hasConflictMarkers(content: string): boolean {
  return splitLines(content).some((line) => {
    const found = markerOf(line);
    return found?.marker === "start" || found?.marker === "end";
  });
}

/** Up to `count` lines before and after a hunk, markers of other hunks included. */
export function hunkContext(
  parsed: ParsedConflictFile,
  hunk: ConflictHunk,
  count: number,
): { before: string; after: string } {
  const startIndex = hunk.startLine - 1;
  return {
    before: parsed.lines.slice(Math.max(0, startIndex - count), startIndex).join(""),
    after: parsed.lines.slice(hunk.endLine, hunk.endLine + count).join(""),
  };
}
