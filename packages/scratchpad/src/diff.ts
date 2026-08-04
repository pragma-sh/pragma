/**
 * Zero-dependency line/word diff backing the scratchpad `DiffReview` card.
 *
 * Scratchpads render in a sandboxed iframe with no bundler and no CodeMirror, so
 * the desktop's `@codemirror/merge` view cannot be reused. This module produces
 * the same shape of data that view renders from: rows aligned across the two
 * panes (with spacer rows opposite an insert/delete, like `cm-mergeSpacer`) and
 * word-level segments inside a changed line pair (like `cm-changedText`).
 */

/** How one side of an aligned row relates to the other side. */
export type DiffLineKind = "same" | "changed" | "added" | "removed" | "spacer";

/** A run of text within a line, flagged when it differs from the other side. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** One rendered line on one side of the comparison. */
export interface DiffLine {
  /** Stable React key: unique within a pane and preserved across re-renders. */
  key: string;
  /** 1-based line number, or `null` for a spacer that has no source line. */
  number: number | null;
  kind: DiffLineKind;
  segments: DiffSegment[];
}

/** A single row of the side-by-side comparison. */
export interface DiffRow {
  before: DiffLine;
  after: DiffLine;
}

/**
 * Upper bound on the dynamic-programming table. Beyond it the differing region
 * is reported as a wholesale replacement rather than stalling the frame.
 */
const MAX_DP_CELLS = 250_000;

type EditKind = "equal" | "remove" | "insert";

interface Edit<T> {
  kind: EditKind;
  value: T;
}

/** Spacer facing a line that only exists on the other side. */
function spacer(facing: number): DiffLine {
  return { key: `spacer-${facing}`, number: null, kind: "spacer", segments: [] };
}

/**
 * Aligns `before` and `after` into side-by-side rows: equal lines share a row,
 * a delete paired with an insert becomes a `changed` row with word-level
 * segments, and an unpaired delete or insert is faced by a spacer.
 */
export function alignDiffLines(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let beforeNumber = 0;
  let afterNumber = 0;
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index += 1) {
      const [left, right] = changedSegments(removed[index] ?? "", added[index] ?? "");
      beforeNumber += 1;
      afterNumber += 1;
      rows.push({
        before: { key: `b${beforeNumber}`, number: beforeNumber, kind: "changed", segments: left },
        after: { key: `a${afterNumber}`, number: afterNumber, kind: "changed", segments: right },
      });
    }
    for (const text of removed.slice(paired)) {
      beforeNumber += 1;
      rows.push({
        before: {
          key: `b${beforeNumber}`,
          number: beforeNumber,
          kind: "removed",
          segments: wholeLine(text),
        },
        after: spacer(beforeNumber),
      });
    }
    for (const text of added.slice(paired)) {
      afterNumber += 1;
      rows.push({
        before: spacer(afterNumber),
        after: {
          key: `a${afterNumber}`,
          number: afterNumber,
          kind: "added",
          segments: wholeLine(text),
        },
      });
    }
    removed = [];
    added = [];
  };

  for (const edit of diffSequences(splitLines(before), splitLines(after))) {
    if (edit.kind === "remove") {
      removed.push(edit.value);
      continue;
    }
    if (edit.kind === "insert") {
      added.push(edit.value);
      continue;
    }
    flush();
    beforeNumber += 1;
    afterNumber += 1;
    rows.push({
      before: {
        key: `b${beforeNumber}`,
        number: beforeNumber,
        kind: "same",
        segments: wholeLine(edit.value),
      },
      after: {
        key: `a${afterNumber}`,
        number: afterNumber,
        kind: "same",
        segments: wholeLine(edit.value),
      },
    });
  }
  flush();
  return rows;
}

/** Splits text into lines, ignoring one trailing newline and `\r\n` endings. */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized === "" ? [] : normalized.split("\n");
}

function wholeLine(text: string): DiffSegment[] {
  return text === "" ? [] : [{ text, changed: false }];
}

/** Word-level segments for a replaced line pair: `[before, after]`. */
function changedSegments(before: string, after: string): [DiffSegment[], DiffSegment[]] {
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  for (const edit of diffSequences(splitWords(before), splitWords(after))) {
    if (edit.kind !== "insert") {
      push(left, edit.value, edit.kind === "remove");
    }
    if (edit.kind !== "remove") {
      push(right, edit.value, edit.kind === "insert");
    }
  }
  return [left, right];
}

/** Appends text to `segments`, merging into the previous run of the same kind. */
function push(segments: DiffSegment[], text: string, changed: boolean): void {
  const last = segments.at(-1);
  if (last && last.changed === changed) {
    last.text += text;
    return;
  }
  segments.push({ text, changed });
}

/** Splits a line into words and the whitespace runs between them. */
function splitWords(line: string): string[] {
  return line.split(/(\s+)/).filter((part) => part !== "");
}

/**
 * Longest-common-subsequence diff over two sequences. Shared prefixes/suffixes
 * are matched directly so the quadratic table only covers the differing middle;
 * a middle above {@link MAX_DP_CELLS} degrades to a whole-region replacement.
 */
function diffSequences<T>(a: readonly T[], b: readonly T[]): Edit<T>[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end += 1;
  }

  const head = a.slice(0, start).map((value): Edit<T> => ({ kind: "equal", value }));
  const tail = a.slice(a.length - end).map((value): Edit<T> => ({ kind: "equal", value }));
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

/** Every element of `a` removed, then every element of `b` inserted. */
function replaceAll<T>(a: readonly T[], b: readonly T[]): Edit<T>[] {
  return [
    ...a.map((value): Edit<T> => ({ kind: "remove", value })),
    ...b.map((value): Edit<T> => ({ kind: "insert", value })),
  ];
}

/**
 * Row-major LCS table where cell `(i, j)` holds the LCS length of `a[i..]` and `b[j..]`.
 * Row stride is `b.length + 1`, so the trailing row/column of zero sentinels is included.
 */
function lcsTable<T>(a: readonly T[], b: readonly T[]): Uint32Array {
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  return lengths;
}

function diffMiddle<T>(a: readonly T[], b: readonly T[]): Edit<T>[] {
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DP_CELLS) {
    return replaceAll(a, b);
  }
  return walkLcsTable(a, b, lcsTable(a, b));
}

/**
 * Walks the LCS table from `(0, 0)`, taking the branch that keeps the longer
 * common subsequence ahead of it, then replaces whatever tail is left over.
 */
function walkLcsTable<T>(a: readonly T[], b: readonly T[], lengths: Uint32Array): Edit<T>[] {
  const width = b.length + 1;
  const edits: Edit<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] as T;
    const right = b[j] as T;
    if (left === right) {
      edits.push({ kind: "equal", value: left });
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      edits.push({ kind: "remove", value: left });
      i += 1;
    } else {
      edits.push({ kind: "insert", value: right });
      j += 1;
    }
  }
  return [...edits, ...replaceAll(a.slice(i), b.slice(j))];
}
