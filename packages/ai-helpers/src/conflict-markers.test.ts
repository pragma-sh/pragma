import { describe, expect, it } from "vitest";

import {
  applyResolutions,
  type ConflictResolution,
  hasConflictMarkers,
  MalformedConflictError,
  parseConflicts,
} from "./conflict-markers.ts";

const TWO_CONFLICTS = [
  "import a\n",
  "<<<<<<< HEAD\n",
  "const x = 1;\n",
  "=======\n",
  "const x = 2;\n",
  ">>>>>>> origin/main\n",
  "middle\n",
  "<<<<<<< HEAD\n",
  "ours\n",
  "||||||| merged common ancestors\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> origin/main\n",
  "end\n",
].join("");

function resolveAll(content: string, resolution: ConflictResolution): string {
  const parsed = parseConflicts(content);
  return applyResolutions(parsed, new Map(parsed.hunks.map((hunk) => [hunk.id, resolution])));
}

describe("parseConflicts", () => {
  it("splits standard and diff3 hunks with line numbers and labels", () => {
    const { hunks } = parseConflicts(TWO_CONFLICTS);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      id: "c1",
      startLine: 2,
      endLine: 6,
      ours: "const x = 1;\n",
      base: null,
      theirs: "const x = 2;\n",
      oursLabel: "HEAD",
      theirsLabel: "origin/main",
    });
    expect(hunks[1]).toMatchObject({
      id: "c2",
      ours: "ours\n",
      base: "base\n",
      theirs: "theirs\n",
    });
  });

  it("treats a longer run of = as content, not a separator", () => {
    const { hunks } = parseConflicts("<<<<<<< HEAD\n========\n=======\nb\n>>>>>>> x\n");
    expect(hunks[0]?.ours).toBe("========\n");
  });

  it("reads markers as wide as the file's conflict-marker-size", () => {
    const wide = [
      "a\n",
      "<<<<<<<<<< HEAD\n",
      "x\n",
      "=======\n",
      "==========\n",
      "y\n",
      ">>>>>>>>>> m\n",
      "b\n",
    ].join("");
    const parsed = parseConflicts(wide);
    expect(parsed.markerSizes).toEqual([10]);
    expect(parsed.hunks[0]).toMatchObject({ ours: "x\n=======\n", theirs: "y\n" });
    expect(resolveAll(wide, { kind: "theirs" })).toBe("a\ny\nb\n");
  });

  it("rejects unterminated and nested markers", () => {
    expect(() => parseConflicts("<<<<<<< HEAD\na\n=======\n")).toThrow(MalformedConflictError);
    expect(() => parseConflicts("<<<<<<< HEAD\n<<<<<<< HEAD\n")).toThrow(MalformedConflictError);
  });

  it("preserves CRLF line endings outside and inside conflicts", () => {
    const crlf = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> m\r\nb\r\n";
    expect(resolveAll(crlf, { kind: "theirs" })).toBe("a\r\ny\r\nb\r\n");
  });
});

describe("applyResolutions", () => {
  it("applies each standard choice", () => {
    expect(resolveAll(TWO_CONFLICTS, { kind: "ours" })).toBe(
      "import a\nconst x = 1;\nmiddle\nours\nend\n",
    );
    expect(resolveAll(TWO_CONFLICTS, { kind: "both_theirs_first" })).toBe(
      "import a\nconst x = 2;\nconst x = 1;\nmiddle\ntheirs\nours\nend\n",
    );
  });

  it("adds a line break between sides and after custom text when missing", () => {
    const noTrailing = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> m\n";
    expect(resolveAll(noTrailing, { kind: "custom", content: "merged" })).toBe("merged\n");
    expect(resolveAll(noTrailing, { kind: "custom", content: "" })).toBe("");
  });

  it("throws when a conflict has no resolution", () => {
    expect(() => applyResolutions(parseConflicts(TWO_CONFLICTS), new Map())).toThrow(/c1/);
  });
});

describe("hasConflictMarkers", () => {
  it("detects start and end markers only", () => {
    expect(hasConflictMarkers(TWO_CONFLICTS)).toBe(true);
    expect(hasConflictMarkers("Title\n=======\n")).toBe(false);
  });

  it("checks only the widths it is given", () => {
    const wide = "<<<<<<<<<< HEAD\nx\n==========\ny\n>>>>>>>>>> m\n";
    expect(hasConflictMarkers(wide)).toBe(false);
    expect(hasConflictMarkers(wide, [10])).toBe(true);
  });
});
