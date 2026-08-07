/** A predicate narrowing one field of a parsed JSON value. */
export type FieldGuard = (value: unknown) => boolean;

/**
 * Checks a parsed JSON value field by field.
 *
 * Both files this package parses — the comment thread and the managed
 * frontmatter — are written by another process (an agent, or an older Pragma),
 * so every field is validated before it is trusted. Sharing one checker keeps
 * those two validations from drifting into subtly different strictness.
 */
export function matchesShape(value: unknown, fields: Record<string, FieldGuard>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(fields).every(([field, guard]) => guard(record[field]));
}

/** Field is a string. */
export const isString: FieldGuard = (value) => typeof value === "string";

/** Field is a number. */
export const isNumber: FieldGuard = (value) => typeof value === "number";

/** Field is `null` or passes `guard`. */
export function nullable(guard: FieldGuard): FieldGuard {
  return (value) => value === null || guard(value);
}
