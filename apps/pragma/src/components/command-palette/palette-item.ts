/**
 * Shared column classes for command-palette rows.
 *
 * Every row is a two-column grid in spirit: a flexible primary label and a
 * fixed-width secondary column. The secondary column is left-aligned at a
 * constant width rather than pushed right with `ml-auto`, so the first
 * character of the secondary text starts at the same x on every row instead of
 * drifting with the text's own length.
 */

/** The primary label: absorbs all leftover width and truncates. */
export const paletteItemLabel = "min-w-0 flex-1 truncate";

/** The secondary column: fixed width, left-aligned, so rows line up. */
export const paletteItemMeta = "w-2/5 shrink-0 truncate text-left text-xs text-muted-foreground";
