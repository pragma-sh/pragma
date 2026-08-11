// Web counterpart of `secret-store.ts`. A browser has no keychain, so the
// gateway token lives in Web Storage — which means any script running on the
// origin can read it. Two deliberate consequences:
//
//   * `sessionStorage` is the default, so a token dies with the tab. A user has
//     to opt in ("remember this browser") before it survives a restart.
//   * Storage is per-origin, so a token pasted into one tunnel URL is never
//     readable from another host.
//
// Storage can throw or be entirely absent (private browsing, embedded webviews,
// storage disabled), so every access falls back to an in-memory map for the
// lifetime of the page rather than failing the app.

const PERSIST_FLAG_KEY = "pragma.remember-browser.v1";

/** Prefix every key this app owns shares, so a migration touches nothing else. */
const KEY_PREFIX = "pragma.";

const memory = new Map<string, string>();

let persistent = readPersistFlag();

function storage(kind: "local" | "session"): Storage | null {
  try {
    const candidate = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    // Safari with storage blocked exposes the object but throws on access.
    candidate.getItem(PERSIST_FLAG_KEY);
    return candidate;
  } catch {
    return null;
  }
}

function readPersistFlag(): boolean {
  return storage("local")?.getItem(PERSIST_FLAG_KEY) === "true";
}

function activeStore(): Storage | null {
  return storage(persistent ? "local" : "session");
}

/** Reads a stored value, or null when absent. */
export async function getItemAsync(key: string): Promise<string | null> {
  // Read both stores regardless of the current preference: a value written
  // before the user toggled "remember" must stay readable after the toggle.
  return (
    storage("session")?.getItem(key) ?? storage("local")?.getItem(key) ?? memory.get(key) ?? null
  );
}

/** Persists a value in the store the current preference selects. */
export async function setItemAsync(key: string, value: string): Promise<void> {
  const target = activeStore();
  if (!target) {
    memory.set(key, value);
    return;
  }
  target.setItem(key, value);
  // Never leave a copy behind in the store we are not using.
  const other = storage(persistent ? "session" : "local");
  if (other !== target) other?.removeItem(key);
}

/** Removes a stored value from every backing store. */
export async function deleteItemAsync(key: string): Promise<void> {
  storage("local")?.removeItem(key);
  storage("session")?.removeItem(key);
  memory.delete(key);
}

/** Whether stored values survive closing the tab. */
export function isPersistent(): boolean {
  return persistent;
}

/**
 * Switches between tab-lifetime and durable storage, migrating anything already
 * stored so toggling the preference never signs the user out.
 */
export function setPersistent(next: boolean): void {
  if (next === persistent) return;
  const from = activeStore();
  persistent = next;
  migrateKeys(from, activeStore());
  storage("local")?.setItem(PERSIST_FLAG_KEY, String(next));
}

/**
 * Moves this app's keys from one store to the other. A no-op when either store
 * is unavailable or they are already the same one.
 */
function migrateKeys(from: Storage | null, to: Storage | null): void {
  if (from && to && from !== to) moveOwnedKeys(from, to);
}

/**
 * Collects the keys first so the move never mutates the collection it is
 * walking — removing a key re-indexes everything after it.
 */
function moveOwnedKeys(from: Storage, to: Storage): void {
  for (const key of ownedKeys(from)) moveKey(from, to, key);
}

/** This app's keys in a store, ignoring whatever else shares the origin. */
function ownedKeys(store: Storage): string[] {
  return Object.keys(store).filter((key) => key.startsWith(KEY_PREFIX));
}

function moveKey(from: Storage, to: Storage, key: string): void {
  const value = from.getItem(key);
  if (value !== null) to.setItem(key, value);
  from.removeItem(key);
}
