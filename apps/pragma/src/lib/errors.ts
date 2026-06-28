/** Normalizes an unknown thrown value into a human-readable message. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
