import { describe, expect, it } from "vitest";

import {
  contextMention,
  contextQuery,
  defineContextProvider,
  ContextProviderNotice,
  formatPromptWithContext,
  isContextProviderNotice,
  matchContextItems,
  splitPromptContext,
} from "./context";

describe("contextQuery", () => {
  it("reads the mention being typed at the caret", () => {
    expect(contextQuery("@")).toBe("");
    expect(contextQuery("fix @src/ma")).toBe("src/ma");
    expect(contextQuery("line one\n@#12")).toBe("#12");
  });

  it("ignores emails, committed mentions, and plain text", () => {
    expect(contextQuery("mail me@example.com")).toBeNull();
    expect(contextQuery("see @file.ts ")).toBeNull();
    expect(contextQuery("no mention")).toBeNull();
  });
});

describe("matchContextItems", () => {
  const items = [
    { id: "1", displayName: "src/components/CommandPalette.tsx" },
    { id: "2", displayName: "#12", searchText: "#12 Command palette crashes" },
    { id: "3", displayName: "README.md" },
  ];

  it("ranks prefix, then substring, then fuzzy matches", () => {
    expect(matchContextItems(items, "readme").map((item) => item.id)).toEqual(["3"]);
    expect(matchContextItems(items, "#12").map((item) => item.id)).toEqual(["2"]);
    expect(matchContextItems(items, "command").map((item) => item.id)).toEqual(["1", "2"]);
    expect(matchContextItems(items, "cmdpal").map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("keeps provider order and the limit for an empty query", () => {
    expect(matchContextItems(items, "", 2).map((item) => item.id)).toEqual(["1", "2"]);
  });
});

describe("formatPromptWithContext", () => {
  it("appends one context element per non-empty block", () => {
    const prompt = formatPromptWithContext("Fix @#12 ", [
      { mention: "@#12", source: 'GitHub "issues"', content: "Body\n" },
      { mention: "@empty", source: "Files", content: "  " },
    ]);
    expect(prompt).toBe(
      'Fix @#12\n\n<context mention="@#12" source="GitHub &quot;issues&quot;">\nBody\n</context>',
    );
  });

  it("leaves a prompt without context untouched", () => {
    expect(formatPromptWithContext("hello ", [])).toBe("hello ");
  });
});

describe("splitPromptContext", () => {
  const blocks = [
    { mention: "@#12", source: 'GitHub "issues"', content: "Body\n\nmore" },
    { mention: "@a.ts", source: "Files", content: "Read it" },
  ];

  it("round-trips a formatted prompt", () => {
    const stored = formatPromptWithContext("Fix @#12 and @a.ts", blocks);
    expect(splitPromptContext(stored)).toEqual({ prompt: "Fix @#12 and @a.ts", blocks });
  });

  it("round-trips context attached to an empty prompt", () => {
    const stored = formatPromptWithContext("", blocks.slice(1));
    expect(splitPromptContext(stored)).toEqual({ prompt: "", blocks: blocks.slice(1) });
  });

  it("leaves a prompt without trailing context blocks alone", () => {
    const text = 'Explain <context mention="x" source="y">\nz\n</context> then more';
    expect(splitPromptContext(text)).toEqual({ prompt: text, blocks: [] });
    expect(splitPromptContext("plain")).toEqual({ prompt: "plain", blocks: [] });
  });
});

describe("defineContextProvider", () => {
  it("returns the definition and mentions use the display name", async () => {
    const provider = defineContextProvider({
      id: "docs",
      title: "Docs",
      search: () => [{ id: "a", displayName: "guide" }],
      resolve: ({ item }) => `doc ${item.id}`,
    });
    const [item] = await provider.search(
      { query: "", project: null, worktree: null, signal: new AbortController().signal },
      {} as never,
    );
    expect(contextMention(item!)).toBe("@guide");
  });
});

describe("isContextProviderNotice", () => {
  it("recognizes notices by name, including another bundle's copy", () => {
    const foreign = Object.assign(new Error("Sign in"), { name: "ContextProviderNotice" });
    expect(isContextProviderNotice(new ContextProviderNotice("Sign in"))).toBe(true);
    expect(isContextProviderNotice(foreign)).toBe(true);
    expect(isContextProviderNotice(new Error("boom"))).toBe(false);
    expect(isContextProviderNotice("Sign in")).toBe(false);
  });
});
