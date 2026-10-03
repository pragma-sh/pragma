/**
 * Account switching for a harness that keeps every provider's credential in
 * one shared JSON file (OpenCode's and Pi's `auth.json`).
 *
 * Each Pragma-added login keeps its own copy of the file in its `home` while
 * another login is active. Before a launch, `activateCredentialSwap` moves one
 * provider's entries: the entries currently in the shared file are saved back
 * to the login they belong to (so a token the harness refreshed is never
 * lost), then the bound login's entries are written in. Every other
 * provider's entries are left alone. A new login is activated while still
 * empty, then signs in in place.
 *
 * Which login occupies the shared file, and the harness's own sign-in while it
 * is displaced, are recorded in a `<file>.pragma.json` beside the shared file.
 * Tokens are copied, never refreshed: one sign-in only ever lives in one place
 * at a time, so a rotating refresh token is never used from two copies.
 */
import type { AccountContext } from "./accounts";
import type { CredentialStore } from "./account-identity";
import { expandHome, hostBuiltin, hostProcess, recordValue } from "./host";

/** Suffix of the bookkeeping file kept beside a shared credential file. */
const STATE_SUFFIX = ".pragma.json";
/**
 * The lock `proper-lockfile` takes (Pi's auth storage uses it): a directory
 * named `<file>.lock`. Taking the same lock keeps a swap from interleaving with
 * a token refresh Pi is writing.
 */
const LOCK_SUFFIX = ".lock";
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 100;
/** A lock older than this was left by a crashed writer. */
const LOCK_STALE_MS = 30_000;
const PRIVATE_FILE_MODE = 0o600;

type Entries = Record<string, unknown>;

/** What `<file>.pragma.json` records per provider. */
interface SwapState {
  providers: Record<string, ProviderSwapState>;
}

interface ProviderSwapState {
  /** The Pragma login home whose entries are in the shared file; null for the harness's own. */
  active: string | null;
  /** The harness's own entries, kept while a Pragma login occupies the shared file. */
  own?: Entries;
}

interface FsPromises {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (path: string, data: string, options: { mode: number }) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<unknown>;
  rmdir: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
}

/** The shared credential file a launch with `env` reads. */
export async function sharedCredentialFile(
  store: CredentialStore,
  env: Record<string, string>,
): Promise<string> {
  const dir = env[store.dirEnv] ?? hostProcess()?.env?.[store.dirEnv] ?? store.defaultDir;
  return `${await expandHome(dir)}/${store.file}`;
}

/** A Pragma login's own copy of the credential file. */
export function loginCredentialFile(store: CredentialStore, home: string): string {
  return `${home}/${store.file}`;
}

/**
 * A login's entries for `provider` right now: the shared file's while the
 * login is the active one, else its saved copy — its own home for a Pragma
 * login, the copy beside the shared file for the harness's own sign-in.
 */
export async function readLoginEntries(
  store: CredentialStore,
  provider: string,
  entries: readonly string[],
  account: Pick<AccountContext["account"], "home" | "env">,
): Promise<Entries | null> {
  const shared = await sharedCredentialFile(store, account.env);
  const active = (await readState(shared)).providers[provider];
  const activeHome = active?.active ?? null;
  if (activeHome === account.home) {
    const current = await readJson(shared);
    return current ? pick(current, entries) : null;
  }
  if (account.home === null) return active?.own ?? {};
  const own = await readJson(loginCredentialFile(store, account.home));
  return own ? pick(own, entries) : null;
}

/**
 * Merges `updates` into a login's entries for `provider`, wherever they live
 * right now (see {@link readLoginEntries}): the shared file while the login is
 * active, else its saved copy.
 */
export async function writeLoginEntries(
  store: CredentialStore,
  provider: string,
  account: Pick<AccountContext["account"], "home" | "env">,
  updates: Entries,
): Promise<void> {
  const shared = await sharedCredentialFile(store, account.env);
  const fs = hostBuiltin<FsPromises>("node:fs/promises");
  await fs.mkdir(parentDir(shared), { recursive: true, mode: 0o700 });
  await withLock(fs, shared, async () => {
    const state = await readState(shared);
    const slot = state.providers[provider];
    if ((slot?.active ?? null) === account.home) {
      await writeJson(fs, shared, { ...(await readJson(shared)), ...updates });
    } else if (account.home === null && slot) {
      slot.own = { ...slot.own, ...updates };
      await writeJson(fs, `${shared}${STATE_SUFFIX}`, state);
    } else if (account.home !== null) {
      const path = loginCredentialFile(store, account.home);
      await fs.mkdir(parentDir(path), { recursive: true, mode: 0o700 });
      await writeJson(fs, path, { ...(await readJson(path)), ...updates });
    }
  });
}

/**
 * Puts `account`'s entries for one provider into the shared credential file,
 * saving the entries it replaces back to the login they belong to.
 */
export async function activateCredentialSwap(
  store: CredentialStore,
  provider: string,
  entries: readonly string[],
  account: Pick<AccountContext["account"], "home" | "env">,
): Promise<void> {
  const shared = await sharedCredentialFile(store, account.env);
  const fs = hostBuiltin<FsPromises>("node:fs/promises");
  await fs.mkdir(parentDir(shared), { recursive: true, mode: 0o700 });
  await withLock(fs, shared, () =>
    swapLocked({ fs, store, shared, provider, entries, target: account.home }),
  );
}

/** One swap, run while holding the shared file's lock. */
interface Swap {
  fs: FsPromises;
  store: CredentialStore;
  shared: string;
  provider: string;
  entries: readonly string[];
  /** The login to put in: a Pragma login home, or null for the harness's own. */
  target: string | null;
}

async function swapLocked(swap: Swap): Promise<void> {
  const { fs, shared, provider, entries, target } = swap;
  const state = await readState(shared);
  const slot = state.providers[provider] ?? { active: null };
  if (slot.active === target) return;

  const current = (await readJson(shared)) ?? {};
  const incoming = await incomingEntries(swap, slot);
  // Save the outgoing entries first: a crash between writes must lose nothing.
  const own = await saveOutgoing(swap, state, slot, pick(current, entries));

  await writeJson(fs, shared, { ...omit(current, entries), ...incoming });
  if (target === null) {
    delete state.providers[provider];
  } else {
    state.providers[provider] = { active: target, ...(own ? { own } : {}) };
  }
  await writeJson(fs, `${shared}${STATE_SUFFIX}`, state);
}

/** The target login's entries. An empty login (one about to sign in) leaves the provider signed out. */
async function incomingEntries(swap: Swap, slot: ProviderSwapState): Promise<Entries> {
  if (swap.target === null) return slot.own ?? {};
  const stored = await readJson(loginCredentialFile(swap.store, swap.target));
  return pick(stored ?? {}, swap.entries);
}

/**
 * Saves the entries leaving the shared file to the login they belong to, and
 * returns the harness's own entries as they now stand.
 */
async function saveOutgoing(
  swap: Swap,
  state: SwapState,
  slot: ProviderSwapState,
  outgoing: Entries,
): Promise<Entries | undefined> {
  if (slot.active !== null) {
    await saveBack(swap.fs, loginCredentialFile(swap.store, slot.active), outgoing, swap.entries);
    return slot.own;
  }
  state.providers[swap.provider] = { active: null, own: outgoing };
  await writeJson(swap.fs, `${swap.shared}${STATE_SUFFIX}`, state);
  return outgoing;
}

/**
 * Writes a displaced login's entries back to its own copy. A login whose home
 * was removed has nowhere to go; its entries are dropped with it.
 */
async function saveBack(
  fs: FsPromises,
  path: string,
  outgoing: Entries,
  entries: readonly string[],
): Promise<void> {
  const existing = await readJson(path);
  if (existing === null) {
    try {
      await fs.stat(parentDir(path));
    } catch {
      return;
    }
  }
  await writeJson(fs, path, { ...omit(existing ?? {}, entries), ...outgoing });
}

async function withLock<T>(fs: FsPromises, file: string, run: () => Promise<T>): Promise<T> {
  const lock = `${file}${LOCK_SUFFIX}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retrying one lock is sequential by nature.
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (!isExists(error) || attempt >= LOCK_RETRIES) throw error;
      // oxlint-disable-next-line no-await-in-loop -- see above.
      if (await isStale(fs, lock)) {
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await fs.rmdir(lock).catch(() => undefined);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await run();
  } finally {
    await fs.rmdir(lock).catch(() => undefined);
  }
}

async function isStale(fs: FsPromises, lock: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(lock)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function isExists(error: unknown): boolean {
  return recordValue(error)?.code === "EEXIST";
}

async function readState(shared: string): Promise<SwapState> {
  const value = await readJson(`${shared}${STATE_SUFFIX}`);
  const providers = recordValue(value?.providers);
  return { providers: (providers ?? {}) as Record<string, ProviderSwapState> };
}

async function readJson(path: string): Promise<Entries | null> {
  const { readFile } = hostBuiltin<FsPromises>("node:fs/promises");
  try {
    return recordValue(JSON.parse(await readFile(path, "utf8"))) ?? null;
  } catch {
    return null;
  }
}

/** Writes in place, like the harnesses themselves, and keeps the file owner-only. */
async function writeJson(fs: FsPromises, path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  await fs.chmod(path, PRIVATE_FILE_MODE);
}

function pick(source: Entries, keys: readonly string[]): Entries {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

function omit(source: Entries, keys: readonly string[]): Entries {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}
