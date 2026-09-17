import { describe, expect, it } from "vitest";

import { EMOJI_GROUPS, searchEmoji } from "./emoji-catalog";

describe("searchEmoji", () => {
  it("returns the whole catalog for a blank query", () => {
    expect(searchEmoji("   ")).toBe(EMOJI_GROUPS);
  });

  it("matches upstream keyword tags, not just the label", () => {
    // "space" is a tag on the rocket, never a word in its name.
    const matches = searchEmoji("rocket space").flatMap((group) => group.emoji);

    expect(matches.map((entry) => entry.char)).toContain("🚀");
  });

  it("matches the generator's extra developer synonyms", () => {
    // Proves EXTRA_TERMS survives generation; Unicode calls this one "whale".
    const matches = searchEmoji("docker").flatMap((group) => group.emoji);

    expect(matches.map((entry) => entry.char)).toContain("🐳");
  });

  it("requires every term, so extra words narrow the grid", () => {
    const one = searchEmoji("book").flatMap((group) => group.emoji);
    const two = searchEmoji("book blue").flatMap((group) => group.emoji);

    expect(two.length).toBeGreaterThan(0);
    expect(one.length).toBeGreaterThan(two.length);
  });

  it("drops groups that have no match rather than showing empty headings", () => {
    expect(searchEmoji("qqqq")).toEqual([]);
  });
});

describe("EMOJI_GROUPS", () => {
  it("carries the full Unicode set rather than a hand-picked subset", () => {
    const count = EMOJI_GROUPS.reduce((total, group) => total + group.emoji.length, 0);

    expect(count).toBeGreaterThan(1500);
    expect(EMOJI_GROUPS.length).toBeGreaterThanOrEqual(8);
  });

  it("omits the component group, whose members are not standalone icons", () => {
    const chars = EMOJI_GROUPS.flatMap((group) => group.emoji.map((entry) => entry.char));

    // A skin-tone modifier and a regional indicator: only ever combining parts.
    expect(chars).not.toContain("🏻");
    expect(chars).not.toContain("🇦");
  });

  it("has no duplicate glyphs, which would break picker keys", () => {
    const chars = EMOJI_GROUPS.flatMap((group) => group.emoji.map((entry) => entry.char));

    expect(new Set(chars).size).toBe(chars.length);
  });

  it("labels every glyph in lowercase so search can match it", () => {
    for (const group of EMOJI_GROUPS) {
      for (const entry of group.emoji) {
        expect(entry.label).toBe(entry.label.toLowerCase());
        expect(entry.label.trim()).not.toBe("");
      }
    }
  });
});
