/**
 * Character-budget helpers for text sent to a model. Each marks where it cut,
 * so the model never mistakes a clipped excerpt for the whole text.
 */

/** Keeps the start of `text` (trimmed) within `limit` characters. */
export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…(truncated)` : trimmed;
}

/**
 * Keeps the end of `text` (trimmed) within `limit` characters — for an agent's
 * reply, whose latest work is described last.
 */
export function truncateStart(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `(truncated)…\n${trimmed.slice(-limit)}` : trimmed;
}
