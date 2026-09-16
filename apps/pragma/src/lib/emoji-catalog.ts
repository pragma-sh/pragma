/**
 * The emoji catalog behind the picker.
 *
 * The glyphs, their English labels and their search keywords all come from
 * Unicode via `emojibase-data`; `scripts/generate-emoji-catalog.ts` compiles
 * them into `src/generated/emoji-catalog.ts`. Nothing here enumerates emoji by
 * hand — add search terms in the generator's `EXTRA_TERMS`, and bump the
 * dependency to pick up a new Unicode release.
 *
 * This module is imported lazily by `EmojiPicker` (the generated data is ~115 KB
 * of source), so importing it eagerly from app startup code would undo that.
 */
import { EMOJI_GROUP_DATA } from "@/generated/emoji-catalog";

/** A named group of emoji, shown as one section in the picker. */
export interface EmojiGroup {
  /** Heading shown above the group in the picker. */
  name: string;
  emoji: EmojiEntry[];
}

/** One pickable emoji: the glyph plus the words that should find it. */
export interface EmojiEntry {
  char: string;
  /** Lowercase name and synonyms, space separated. */
  label: string;
}

/** Every pickable emoji, grouped for display in Unicode group order. */
export const EMOJI_GROUPS: EmojiGroup[] = EMOJI_GROUP_DATA.map(([name, entries]) => ({
  name,
  emoji: entries.map(([char, label]) => ({ char, label })),
}));

/**
 * Groups filtered to entries whose label contains every whitespace-separated
 * term in `query`. Empty groups are dropped; a blank query returns the catalog
 * untouched.
 */
export function searchEmoji(query: string): EmojiGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return EMOJI_GROUPS;
  }
  const groups: EmojiGroup[] = [];
  for (const candidate of EMOJI_GROUPS) {
    const emoji = candidate.emoji.filter((entry) =>
      terms.every((term) => entry.label.includes(term)),
    );
    if (emoji.length > 0) {
      groups.push({ name: candidate.name, emoji });
    }
  }
  return groups;
}
