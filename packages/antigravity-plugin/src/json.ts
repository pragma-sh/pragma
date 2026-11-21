// Narrowing helpers for agy's untyped JSON (hook payloads, transcripts, `/usage`).

/** The value as a plain object, or null for anything else (arrays included). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The plain-object entries of an array; anything else yields none. */
export function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((entry) => entry !== null);
}

/** The value if it is a string, else null. */
export function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parses JSON text into a plain object, or null when it is not one. */
export function parseRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}
