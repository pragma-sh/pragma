import { describe, expect, it } from "vitest";

import { prepareMdxSource } from "./mdx-source";

describe("prepareMdxSource", () => {
  it("drops managed frontmatter", () => {
    const source = '---\npragmaScratchpad: {"id":"a"}\n---\n\n# Plan\n';

    expect(prepareMdxSource(source)).toBe("\n# Plan\n");
  });

  it("drops imports the web view has no resolver for", () => {
    const source = [
      'import { AskQuestion } from "@pragma/scratchpad/ui";',
      'import Local from "./local.tsx";',
      "",
      "<AskQuestion question='Ship it?' />",
    ].join("\n");

    expect(prepareMdxSource(source)).toBe("\n<AskQuestion question='Ship it?' />");
  });

  it("leaves a document with neither untouched", () => {
    expect(prepareMdxSource("# Plan\n\nBody\n")).toBe("# Plan\n\nBody\n");
  });

  it("does not mistake prose starting with 'import' for an import", () => {
    expect(prepareMdxSource("importing data is slow\n")).toBe("importing data is slow\n");
  });
});
