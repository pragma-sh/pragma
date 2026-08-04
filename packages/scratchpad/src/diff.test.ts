import { describe, expect, it } from "vitest";

import { alignDiffLines, type DiffLine } from "./diff";

function text(line: DiffLine): string {
  return line.segments.map((segment) => segment.text).join("");
}

function changed(line: DiffLine): string[] {
  return line.segments.filter((segment) => segment.changed).map((segment) => segment.text);
}

describe("alignDiffLines", () => {
  it("marks identical text as unchanged and numbers both sides", () => {
    const rows = alignDiffLines("a\nb\n", "a\nb\n");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.before.kind)).toEqual(["same", "same"]);
    expect(rows.map((row) => row.after.number)).toEqual([1, 2]);
  });

  it("pairs a replaced line and highlights only the changed words", () => {
    const rows = alignDiffLines("const a = 1;", "const a = 2;");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.before.kind).toBe("changed");
    expect(row?.after.kind).toBe("changed");
    expect(changed(row?.before as DiffLine)).toEqual(["1;"]);
    expect(changed(row?.after as DiffLine)).toEqual(["2;"]);
  });

  it("faces an inserted line with a spacer", () => {
    const rows = alignDiffLines("a\nc", "a\nb\nc");
    expect(rows.map((row) => `${row.before.kind}/${row.after.kind}`)).toEqual([
      "same/same",
      "spacer/added",
      "same/same",
    ]);
    expect(rows[1]?.before.number).toBeNull();
    expect(rows[1]?.after.number).toBe(2);
    expect(rows[2]?.before.number).toBe(2);
    expect(rows[2]?.after.number).toBe(3);
  });

  it("faces a deleted line with a spacer", () => {
    const rows = alignDiffLines("a\nb\nc", "a\nc");
    expect(rows.map((row) => `${row.before.kind}/${row.after.kind}`)).toEqual([
      "same/same",
      "removed/spacer",
      "same/same",
    ]);
    expect(text(rows[1]?.before as DiffLine)).toBe("b");
  });

  it("pairs the overlap of a mixed edit and spaces out the remainder", () => {
    const rows = alignDiffLines("one\ntwo", "uno\ndos\ntres");
    expect(rows.map((row) => `${row.before.kind}/${row.after.kind}`)).toEqual([
      "changed/changed",
      "changed/changed",
      "spacer/added",
    ]);
    expect(text(rows[2]?.after as DiffLine)).toBe("tres");
  });

  it("ignores a trailing newline and carriage returns", () => {
    expect(alignDiffLines("a\r\nb\r\n", "a\nb")).toHaveLength(2);
    expect(alignDiffLines("", "")).toEqual([]);
  });
});
