import { describe, expect, it } from "vitest";

import { rankPaletteItems } from "./palette-ranking";

interface Item {
  id: string;
  label: string;
  recency: number;
}

const rank = (items: Item[], query: string) =>
  rankPaletteItems(
    items,
    query,
    (item) => [item.label],
    (item) => item.recency,
    (item) => item.id,
  );

describe("rankPaletteItems", () => {
  it("rejects weak matches and orders equal matches by recency", () => {
    const results = rank(
      [
        { id: "old", label: "command palette", recency: 1 },
        { id: "new", label: "command palette", recency: 2 },
        { id: "weak", label: "completely unrelated", recency: 100 },
      ],
      "command",
    );
    expect(results.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("keeps similarity ahead of recency", () => {
    const results = rank(
      [
        { id: "exact", label: "palette", recency: 1 },
        { id: "recent", label: "project palette search", recency: 100 },
      ],
      "palette",
    );
    expect(results[0]?.id).toBe("exact");
  });
});
