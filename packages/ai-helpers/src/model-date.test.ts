import { describe, expect, it } from "vitest";

import { isModelRecent, isOlderThanMonths, parseModelReleaseDate } from "./model-date.ts";

describe("parseModelReleaseDate", () => {
  it("parses a compact YYYYMMDD suffix", () => {
    expect(parseModelReleaseDate({ id: "claude-3-5-haiku-20241022" })).toEqual(
      new Date(Date.UTC(2024, 9, 22)),
    );
  });

  it("parses a dashed YYYY-MM-DD suffix", () => {
    expect(parseModelReleaseDate({ id: "gpt-5-2025-08-07" })).toEqual(
      new Date(Date.UTC(2025, 7, 7)),
    );
  });

  it("falls back to the name when the id has no date", () => {
    expect(parseModelReleaseDate({ id: "some-model", name: "Some Model 20250101" })).toEqual(
      new Date(Date.UTC(2025, 0, 1)),
    );
  });

  it("returns null when there is no parseable date", () => {
    expect(parseModelReleaseDate({ id: "gpt-4o", name: "GPT-4o" })).toBeNull();
  });

  it("ignores non-date digit runs", () => {
    expect(parseModelReleaseDate({ id: "llama-3-70b" })).toBeNull();
  });
});

describe("isOlderThanMonths", () => {
  const now = new Date(Date.UTC(2026, 5, 22));

  it("is true for a date more than N months ago", () => {
    expect(isOlderThanMonths(new Date(Date.UTC(2026, 1, 1)), 3, now)).toBe(true);
  });

  it("is false for a recent date", () => {
    expect(isOlderThanMonths(new Date(Date.UTC(2026, 4, 1)), 3, now)).toBe(false);
  });
});

describe("isModelRecent", () => {
  const now = new Date(Date.UTC(2026, 5, 22));

  it("keeps undated models (unknown age)", () => {
    expect(isModelRecent({ id: "gpt-4o" }, 3, now)).toBe(true);
  });

  it("excludes models older than the window", () => {
    expect(isModelRecent({ id: "claude-3-5-haiku-20241022" }, 3, now)).toBe(false);
  });

  it("keeps models inside the window", () => {
    expect(isModelRecent({ id: "model-20260501" }, 3, now)).toBe(true);
  });
});
