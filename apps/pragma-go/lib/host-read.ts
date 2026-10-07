import { reportUnauthorized } from "./report-unauthorized";

/** A host read's outcome: the value, or the error it failed with. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Awaits a host read without throwing. A 401 is handed to the connection first,
 * which clears the pairing; every failure is returned for the caller to judge.
 */
export async function settle<T>(read: Promise<T>, onUnauthorized: () => void): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read };
  } catch (error: unknown) {
    reportUnauthorized(error, onUnauthorized);
    return { ok: false, error };
  }
}
