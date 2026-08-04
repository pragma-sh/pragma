/**
 * Selection logic behind the `AskQuestion` choice list, kept out of the
 * component so it can be tested without a DOM.
 */

/** Value identifying the appended "Other" choice; never sent to the agent. */
export const OTHER_VALUE = "pragma:other";

/**
 * Applies a click on `value`: a single-answer list replaces its selection,
 * a `multiple` list toggles the clicked entry and keeps click order.
 */
export function toggleChoice(
  current: readonly string[],
  value: string,
  multiple: boolean,
): readonly string[] {
  if (!multiple) return [value];
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

/**
 * Renders the selection as the answer text sent to the agent: {@link OTHER_VALUE}
 * is replaced by the typed `other` text, blanks are dropped, and multiple
 * selections are joined with commas. An empty result means "not answerable yet"
 * (nothing selected, or only an empty "Other").
 */
export function composeAnswer(selected: readonly string[], other: string): string {
  return selected
    .map((value) => (value === OTHER_VALUE ? other.trim() : value))
    .filter((value) => value !== "")
    .join(", ");
}
