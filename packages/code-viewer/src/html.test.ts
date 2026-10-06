import { describe, expect, it } from "vitest";

import { buildCodeViewerHtml } from "./html";
import { CODE_CONTENT_ELEMENT_ID, isCodeViewerContent } from "./messages";

/** Pulls the embedded config back out exactly as the runtime reads it. */
function embedded(html: string): unknown {
  const open = `<script id="${CODE_CONTENT_ELEMENT_ID}" type="application/json">`;
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

describe("buildCodeViewerHtml", () => {
  it("embeds the content as data the runtime reads back unchanged", () => {
    const content = { kind: "file" as const, path: "src/a.ts", text: "const a = 1;\n" };
    const config = embedded(buildCodeViewerHtml({ content, mode: "light", wrap: true }));
    expect(config).toEqual({ content, mode: "light", wrap: true });
  });

  it("cannot be closed early by a file that contains a script end tag", () => {
    const text = 'const s = "</script><script>alert(1)</script>";';
    const html = buildCodeViewerHtml({ content: { kind: "file", path: "x.ts", text } });
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(embedded(html)).toMatchObject({ content: { text } });
  });

  it("paints the mode's background before the runtime runs", () => {
    const content = { kind: "file" as const, path: "a", text: "" };
    expect(buildCodeViewerHtml({ content, mode: "dark" })).toContain("background:#0b0d10");
    expect(buildCodeViewerHtml({ content, mode: "light" })).toContain("background:#ffffff");
  });
});

describe("isCodeViewerContent", () => {
  it("accepts files and diffs and rejects anything partial", () => {
    expect(isCodeViewerContent({ kind: "file", path: "a", text: "" })).toBe(true);
    expect(isCodeViewerContent({ kind: "diff", path: "a", oldText: "", newText: "x" })).toBe(true);
    expect(isCodeViewerContent({ kind: "diff", path: "a", oldText: "" })).toBe(false);
    expect(isCodeViewerContent({ kind: "image", path: "a" })).toBe(false);
    expect(isCodeViewerContent(null)).toBe(false);
  });
});
