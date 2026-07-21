import { describe, expect, it } from "vitest";

import { findFuzzyMatches, nextFuzzyMatch, previousFuzzyMatch } from "@/lib/fuzzy-match";

describe("findFuzzyMatches", () => {
  it("finds a contiguous match as a single-char-per-position span", () => {
    expect(findFuzzyMatches("foo bar", "bar", false)).toEqual([{ from: 4, to: 7 }]);
  });

  it("finds a subsequence match spanning skipped characters", () => {
    expect(findFuzzyMatches("foo bar", "fb", false)).toEqual([{ from: 0, to: 5 }]);
  });

  it("finds multiple non-overlapping matches", () => {
    expect(findFuzzyMatches("ab ab ab", "ab", false)).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 8 },
    ]);
  });

  it("is case-insensitive when ignoreCase is true", () => {
    expect(findFuzzyMatches("FOO", "foo", true)).toEqual([{ from: 0, to: 3 }]);
    expect(findFuzzyMatches("FOO", "foo", false)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(findFuzzyMatches("anything", "", false)).toEqual([]);
  });

  it("returns nothing when the subsequence doesn't exist", () => {
    expect(findFuzzyMatches("abc", "cab", false)).toEqual([]);
  });
});

describe("nextFuzzyMatch / previousFuzzyMatch", () => {
  const matches = [
    { from: 0, to: 2 },
    { from: 5, to: 7 },
    { from: 10, to: 12 },
  ];

  it("next wraps to the first match past the end", () => {
    expect(nextFuzzyMatch(matches, 6)).toEqual({ from: 10, to: 12 });
    expect(nextFuzzyMatch(matches, 13)).toEqual({ from: 0, to: 2 });
  });

  it("previous wraps to the last match before the start", () => {
    expect(previousFuzzyMatch(matches, 6)).toEqual({ from: 5, to: 7 });
    expect(previousFuzzyMatch(matches, 0)).toEqual({ from: 10, to: 12 });
  });
});
