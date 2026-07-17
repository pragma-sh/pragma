import type { LanguageSupport } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/terminal-manager", () => ({ TERMINAL_FONT_FAMILY: "monospace" }));

import { loadLanguageExtension } from "./codemirror-language";
import { pragmaHighlightStyle } from "./codemirror-theme";

describe("loadLanguageExtension", () => {
  it("loads syntax support that emits highlighted spans", async () => {
    const extension = await loadLanguageExtension("src/app.ts");
    expect(extension).not.toBeNull();

    const support = extension as LanguageSupport;
    const classes: string[] = [];
    highlightTree(
      support.language.parser.parse("const answer: number = 42;"),
      pragmaHighlightStyle,
      (_from, _to, value) => classes.push(value),
    );

    expect(classes.length).toBeGreaterThan(0);
  });
});
