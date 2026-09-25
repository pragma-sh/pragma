import type { ConnectionConfig } from "./pairing";

// Pure, RN-free bookkeeping for hosts this device has connected to before. The
// pair screen lists them so reconnecting is one tap instead of a fresh scan.
// Entries carry the gateway token, so they are stored through `secret-store`
// alongside the active connection; storage lives in `connection-context.tsx`.

/** A host this device connected to successfully at least once. */
export interface SavedHost {
  config: ConnectionConfig;
  hostName: string | null;
  /** Epoch milliseconds of the most recent successful connection. */
  lastConnectedAt: number;
}

/**
 * Cap on remembered hosts. Every entry holds a token, and the whole list is one
 * keychain value, which iOS prefers to keep small.
 */
const MAX_SAVED_HOSTS = 6;

/** Parses stored hosts, tolerating a missing or corrupt entry. */
export function parseSavedHosts(raw: string | null): SavedHost[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedHost) : [];
  } catch {
    return [];
  }
}

/**
 * Records a successful connection: the host moves to the front, replacing any
 * earlier entry for the same URL, and the oldest entries fall off the end. A
 * reconnect that learned no name keeps the one remembered from before.
 */
export function rememberHost(
  hosts: SavedHost[],
  config: ConnectionConfig,
  hostName: string | null,
  now: number,
): SavedHost[] {
  const previous = hosts.find((host) => host.config.url === config.url);
  const entry: SavedHost = {
    config,
    hostName: hostName ?? previous?.hostName ?? null,
    lastConnectedAt: now,
  };
  return [entry, ...forgetHost(hosts, config.url)].slice(0, MAX_SAVED_HOSTS);
}

/** Drops the entry for `url`. */
export function forgetHost(hosts: SavedHost[], url: string): SavedHost[] {
  return hosts.filter((host) => host.config.url !== url);
}

/** The name a saved host is listed under: its own name, else the URL's host. */
export function savedHostLabel(host: SavedHost): string {
  if (host.hostName) return host.hostName;
  return host.config.url.replace(/^https?:\/\//i, "");
}

function isSavedHost(value: unknown): value is SavedHost {
  const entry = value as SavedHost | null;
  return Boolean(
    entry &&
    typeof entry.lastConnectedAt === "number" &&
    typeof entry.config?.url === "string" &&
    typeof entry.config?.token === "string" &&
    (entry.hostName === null || typeof entry.hostName === "string"),
  );
}
