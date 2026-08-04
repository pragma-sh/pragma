/**
 * Small combinators for writing runtime type guards over untrusted values (parsed JSON,
 * `postMessage` payloads). Declaring a shape keeps each guard branch-free instead of
 * repeating a long `typeof` chain per field.
 */

/** True when `value` is a non-null object whose fields can be probed by key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A per-field predicate used by {@link matchesShape}. */
export type FieldGuard = (value: unknown) => boolean;

/** Accepts a `string`. */
export const isString: FieldGuard = (value) => typeof value === "string";

/** Accepts a `number`. */
export const isNumber: FieldGuard = (value) => typeof value === "number";

/** Accepts `null` in addition to whatever `guard` accepts. */
export function nullable(guard: FieldGuard): FieldGuard {
  return (value) => value === null || guard(value);
}

/** Accepts any one of `expected`, compared with `===`. */
export function isOneOf(...expected: readonly unknown[]): FieldGuard {
  return (value) => expected.includes(value);
}

/**
 * True when `value` is a record and every field named in `shape` passes its guard.
 * Fields absent from `shape` are ignored.
 */
export function matchesShape(value: unknown, shape: Record<string, FieldGuard>): boolean {
  return isRecord(value) && Object.entries(shape).every(([key, guard]) => guard(value[key]));
}
