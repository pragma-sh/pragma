import { describe, expect, it } from "vitest";

import { unifiedDiffLines } from "./UnifiedDiff";

describe("unifiedDiffLines", () => {
  it("emits one deletion and one insertion for an inline edit", () => {
    expect(unifiedDiffLines("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
    ]);
  });

  it("splits CRLF inputs without leaking carriage returns", () => {
    expect(unifiedDiffLines("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n")).toEqual([
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
      { sign: "+", text: "d" },
    ]);
  });

  it("treats a new file as all insertions", () => {
    expect(unifiedDiffLines("", "line1\nline2\n")).toEqual([
      { sign: "+", text: "line1" },
      { sign: "+", text: "line2" },
    ]);
  });

  it("treats a deleted file as all deletions", () => {
    expect(unifiedDiffLines("line1\nline2\n", "")).toEqual([
      { sign: "-", text: "line1" },
      { sign: "-", text: "line2" },
    ]);
  });

  it("returns no lines for identical inputs", () => {
    expect(unifiedDiffLines("same\n", "same\n")).toEqual([]);
  });
});
