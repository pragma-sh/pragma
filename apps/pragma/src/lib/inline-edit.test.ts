import { describe, expect, it } from "vitest";

import {
  applyInlineEdits,
  buildInlineEditPreview,
  type InlineEditHunk,
  resolveHunkChange,
} from "@/lib/inline-edit";

/** Applies one hunk decision to a preview document, the way the editor does. */
function resolve(doc: string, hunk: InlineEditHunk, decision: "accept" | "reject"): string {
  const range = resolveHunkChange(hunk, decision);
  return doc.slice(0, range.from) + doc.slice(range.to);
}

describe("applyInlineEdits", () => {
  it("applies replacements in order", () => {
    const result = applyInlineEdits("const a = 1;\nconst b = 2;\n", [
      { oldText: "const a = 1;", newText: "const a = 10;" },
      { oldText: "const b = 2;", newText: "const b = 20;" },
    ]);
    expect(result.doc).toBe("const a = 10;\nconst b = 20;\n");
    expect(result.applied).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it("skips an anchor that is not in the buffer", () => {
    const result = applyInlineEdits("a\n", [{ oldText: "zzz", newText: "b" }]);
    expect(result.doc).toBe("a\n");
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([{ edit: { oldText: "zzz", newText: "b" }, reason: "missing" }]);
  });

  it("skips an ambiguous anchor rather than guessing", () => {
    const result = applyInlineEdits("x\nx\n", [{ oldText: "x", newText: "y" }]);
    expect(result.doc).toBe("x\nx\n");
    expect(result.skipped[0]?.reason).toBe("ambiguous");
  });

  it("treats an empty replacement as a deletion", () => {
    const result = applyInlineEdits("keep\ndrop\n", [{ oldText: "drop\n", newText: "" }]);
    expect(result.doc).toBe("keep\n");
  });
});

describe("buildInlineEditPreview", () => {
  it("has no hunks when nothing changed", () => {
    const preview = buildInlineEditPreview("a\nb\n", "a\nb\n");
    expect(preview.doc).toBe("a\nb\n");
    expect(preview.hunks).toEqual([]);
  });

  it("shows the old lines above the new ones", () => {
    const preview = buildInlineEditPreview("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(preview.doc).toBe("one\ntwo\nTWO\nthree\n");
    expect(preview.hunks).toHaveLength(1);
    const [hunk] = preview.hunks;
    expect(hunk).toBeDefined();
    expect(preview.doc.slice(hunk!.deleted.from, hunk!.deleted.to)).toBe("two\n");
    expect(preview.doc.slice(hunk!.added.from, hunk!.added.to)).toBe("TWO\n");
  });

  it("accepting drops the old lines, rejecting drops the new ones", () => {
    const preview = buildInlineEditPreview("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    const [hunk] = preview.hunks;
    expect(resolve(preview.doc, hunk!, "accept")).toBe("one\nTWO\nthree\n");
    expect(resolve(preview.doc, hunk!, "reject")).toBe("one\ntwo\nthree\n");
  });

  it("handles a pure insertion (no deleted side)", () => {
    const preview = buildInlineEditPreview("a\nc\n", "a\nb\nc\n");
    const [hunk] = preview.hunks;
    expect(hunk!.deleted.from).toBe(hunk!.deleted.to);
    expect(preview.doc.slice(hunk!.added.from, hunk!.added.to)).toBe("b\n");
    expect(resolve(preview.doc, hunk!, "accept")).toBe("a\nb\nc\n");
    expect(resolve(preview.doc, hunk!, "reject")).toBe("a\nc\n");
  });

  it("handles a pure deletion (no added side)", () => {
    const preview = buildInlineEditPreview("a\nb\nc\n", "a\nc\n");
    const [hunk] = preview.hunks;
    expect(hunk!.added.from).toBe(hunk!.added.to);
    expect(resolve(preview.doc, hunk!, "accept")).toBe("a\nc\n");
    expect(resolve(preview.doc, hunk!, "reject")).toBe("a\nb\nc\n");
  });

  it("handles a change on the last line, which has no trailing newline", () => {
    const preview = buildInlineEditPreview("a\nb", "a\nB");
    const [hunk] = preview.hunks;
    expect(resolve(preview.doc, hunk!, "accept")).toBe("a\nB");
    expect(resolve(preview.doc, hunk!, "reject")).toBe("a\nb");
  });

  it("reports separate hunks for changes far apart in the file", () => {
    const base = [
      "import a from 'a';",
      ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
      "end",
    ];
    const proposed = [
      "import a from 'a';",
      "import b from 'b';",
      ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
      "END",
    ];
    const preview = buildInlineEditPreview(base.join("\n"), proposed.join("\n"));
    expect(preview.hunks.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves later hunks correctly once earlier offsets are remapped", () => {
    const preview = buildInlineEditPreview("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\nd\ne\nf\ng\nH\n");
    expect(preview.hunks).toHaveLength(2);
    const [first, second] = preview.hunks;
    // Accepting the first hunk shortens the document; the second hunk's offsets
    // are only valid against the untouched preview, which is why the editor maps
    // them through each change instead of reusing them verbatim.
    const afterFirst = resolve(preview.doc, first!, "accept");
    const shift = preview.doc.length - afterFirst.length;
    const shifted = {
      ...second!,
      deleted: { from: second!.deleted.from - shift, to: second!.deleted.to - shift },
      added: { from: second!.added.from - shift, to: second!.added.to - shift },
    };
    expect(resolve(afterFirst, shifted, "accept")).toBe("a\nB\nc\nd\ne\nf\ng\nH\n");
  });
});
