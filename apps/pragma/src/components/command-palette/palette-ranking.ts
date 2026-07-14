import fuzzysort from "fuzzysort";

const PALETTE_MATCH_THRESHOLD = 0.45;

interface RankedPaletteItem<T> {
  item: T;
  score: number;
  recency: number;
  stableKey: string;
}

/** Ranks local metadata by fuzzy quality, then worktree recency and stable key. */
export function rankPaletteItems<T>(
  items: T[],
  query: string,
  fields: (item: T) => string[],
  recency: (item: T) => number,
  stableKey: (item: T) => string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return items;
  const ranked: RankedPaletteItem<T>[] = [];
  for (const item of items) {
    let score = 0;
    for (const field of fields(item)) {
      score = Math.max(score, fuzzysort.single(trimmed, field)?.score ?? 0);
    }
    if (score >= PALETTE_MATCH_THRESHOLD) {
      ranked.push({ item, score, recency: recency(item), stableKey: stableKey(item) });
    }
  }
  return ranked
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.recency - left.recency ||
        left.stableKey.localeCompare(right.stableKey),
    )
    .map(({ item }) => item);
}
