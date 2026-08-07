import { describe, expect, it } from "vitest";

import {
  createScratchpadComment,
  markAllResolved,
  parseScratchpadComments,
  scratchpadCommentsPath,
  serializeScratchpadComments,
  unresolvedComments,
  unresolvedCommentsPrompt,
} from "./comments";
import type { ScratchpadComment } from "./types";

const comment = (overrides: Partial<ScratchpadComment> = {}): ScratchpadComment => ({
  id: "a",
  from: 0,
  to: 0,
  quote: "The plan",
  text: "Tighten this",
  createdAt: 1,
  resolvedAt: null,
  ...overrides,
});

describe("scratchpad comments", () => {
  it("anchors a new comment to its block without claiming editor positions", () => {
    const created = createScratchpadComment(
      { index: 3, quote: "The plan" },
      "  Tighten  ",
      42,
      "x",
    );

    expect(created).toEqual({
      id: "x",
      from: 0,
      to: 0,
      quote: "The plan",
      text: "Tighten",
      createdAt: 42,
      resolvedAt: null,
      blockIndex: 3,
    });
  });

  it("names the sibling comment file the desktop reads", () => {
    expect(scratchpadCommentsPath(".pragma/scratchpads/plan.mdx")).toBe(
      ".pragma/scratchpads/plan.mdx.comments.json",
    );
  });

  it("round-trips through the on-disk format, dropping malformed entries", () => {
    const serialized = serializeScratchpadComments([comment(), { id: "bad" } as never]);

    const parsed = parseScratchpadComments(serialized);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("a");
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("rejects a comment file that is not an array", () => {
    expect(() => parseScratchpadComments('{"id":"a"}')).toThrow(/must be an array/);
  });

  it("resolves only open comments and leaves resolved ones untouched", () => {
    const resolved = markAllResolved([comment(), comment({ id: "b", resolvedAt: 7 })], 99);

    expect(resolved[0]?.resolvedAt).toBe(99);
    expect(resolved[1]?.resolvedAt).toBe(7);
    expect(unresolvedComments(resolved)).toEqual([]);
  });

  it("hands the agent every open comment with its quote", () => {
    const prompt = unresolvedCommentsPrompt([
      comment(),
      comment({ id: "b", quote: "Step two", text: "Wrong order" }),
    ]);

    expect(prompt).toBe(
      [
        "The user left the following scratchpad comments for you to address:",
        '1. On "The plan": Tighten this',
        '2. On "Step two": Wrong order',
      ].join("\n"),
    );
  });
});
