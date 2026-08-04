import type { ConnectionConfig } from "./pairing";

// Pure, RN-free bookkeeping for push revocations the host never acknowledged.
// Unpairing must succeed offline, but a discarded revocation leaves the host
// pushing agent-alert contents to a phone that is no longer paired — so the
// credentials needed to retry are queued here until the host confirms, or until
// they expire. Storage and delivery live in `push.ts`.

/** A push revocation the host has not acknowledged yet. */
export interface PendingRevocation {
  config: ConnectionConfig;
  /** Epoch milliseconds the revocation was queued. */
  queuedAt: number;
}

/**
 * How long queued host credentials are kept before being dropped. A host that
 * has not come back in a month is not coming back, and retaining its token
 * after the user unpaired is its own small risk.
 */
export const REVOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on queued hosts, so a repeatedly-failing unpair cannot grow unbounded. */
const MAX_PENDING = 5;

/** Parses stored revocations, tolerating a missing or corrupt entry. */
export function parsePendingRevocations(raw: string | null): PendingRevocation[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingRevocation) : [];
  } catch {
    return [];
  }
}

/** Drops revocations whose credentials have outlived {@link REVOCATION_TTL_MS}. */
export function livePendingRevocations(
  pending: PendingRevocation[],
  now: number,
): PendingRevocation[] {
  return pending.filter((entry) => now - entry.queuedAt < REVOCATION_TTL_MS);
}

/** Drops every revocation queued for `url` (it succeeded, or was re-paired). */
export function dropRevocations(pending: PendingRevocation[], url: string): PendingRevocation[] {
  return pending.filter((entry) => entry.config.url !== url);
}

/** Queues a failed revocation, replacing any earlier one for the same host. */
export function queueRevocation(
  pending: PendingRevocation[],
  config: ConnectionConfig,
  now: number,
): PendingRevocation[] {
  const kept = dropRevocations(livePendingRevocations(pending, now), config.url);
  return [...kept, { config, queuedAt: now }].slice(-MAX_PENDING);
}

function isPendingRevocation(value: unknown): value is PendingRevocation {
  const entry = value as PendingRevocation | null;
  return Boolean(
    entry &&
    typeof entry.queuedAt === "number" &&
    typeof entry.config?.url === "string" &&
    typeof entry.config?.token === "string",
  );
}
