import { describe, expect, it } from "vitest";

import { unifiedDiffDocument, unifiedDiffLines } from "./unified-diff";

describe("unifiedDiffDocument", () => {
  it("builds one document line per changed line", () => {
    const lines = unifiedDiffLines("a\nb\n", "a\nc\n");
    const diff = unifiedDiffDocument(lines, "light");
    expect(diff.doc.lines).toBe(lines.length);
    expect(diff.doc.toString()).toBe("b\nc");
  });

  it("still yields a valid document when nothing changed", () => {
    expect(unifiedDiffDocument([], "dark").doc.lines).toBe(1);
  });
});
