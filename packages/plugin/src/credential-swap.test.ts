import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CredentialStore } from "./account-identity";
import { credentialStoreAccount } from "./account-identity";
import { activateCredentialSwap, readLoginEntries, writeLoginEntries } from "./credential-swap";
import { hostBuiltin } from "./host";

/** This package is typed for the webview, so tests reach Node the same way the helpers do. */
const { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } = hostBuiltin<{
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  mkdtemp: (prefix: string) => Promise<string>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  rm: (path: string, options: { recursive: boolean; force?: boolean }) => Promise<void>;
  stat: (path: string) => Promise<{ mode: number }>;
  utimes: (path: string, atime: Date, mtime: Date) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
}>("node:fs/promises");
const { tmpdir } = hostBuiltin<{ tmpdir: () => string }>("node:os");
const join = (...parts: string[]): string => parts.join("/");

const STORE: CredentialStore = {
  dirEnv: "TEST_AGENT_DIR",
  defaultDir: "/unused",
  file: "auth.json",
};
const ENTRIES = ["openai-codex", "openai"];

let root: string;
let shared: string;
let env: Record<string, string>;

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

async function home(name: string, entries?: Record<string, unknown>): Promise<string> {
  const dir = join(root, "accounts", name);
  await mkdir(dir, { recursive: true });
  if (entries) await writeJson(join(dir, "auth.json"), entries);
  return dir;
}

function activate(target: string | null): Promise<void> {
  return activateCredentialSwap(STORE, "openai", ENTRIES, { home: target, env });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "credential-swap-"));
  await mkdir(join(root, "agent"));
  shared = join(root, "agent", "auth.json");
  env = { TEST_AGENT_DIR: join(root, "agent") };
  await writeJson(shared, {
    "openai-codex": { type: "oauth", refresh: "own" },
    openrouter: { type: "api", key: "or-key" },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("activateCredentialSwap", () => {
  it("swaps one provider in and keeps the harness's own sign-in aside", async () => {
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    await activate(a);
    expect(await readJson(shared)).toEqual({
      "openai-codex": { type: "oauth", refresh: "a" },
      openrouter: { type: "api", key: "or-key" },
    });
    expect(await readLoginEntries(STORE, "openai", ENTRIES, { home: null, env })).toEqual({
      "openai-codex": { type: "oauth", refresh: "own" },
    });
    expect(((await stat(shared)).mode & 0o777).toString(8)).toBe("600");
  });

  it("saves a token the harness refreshed back to the login it belongs to", async () => {
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    const b = await home("b", { "openai-codex": { type: "oauth", refresh: "b" } });
    await activate(a);
    // The harness rotates A's refresh token while A is active.
    const current = await readJson(shared);
    await writeJson(shared, { ...current, "openai-codex": { type: "oauth", refresh: "a2" } });
    await activate(b);
    expect((await readJson(join(a, "auth.json")))["openai-codex"]).toEqual({
      type: "oauth",
      refresh: "a2",
    });
    expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "b" });
  });

  it("restores the harness's own sign-in and forgets the swap", async () => {
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    await activate(a);
    await activate(null);
    expect(await readJson(shared)).toEqual({
      "openai-codex": { type: "oauth", refresh: "own" },
      openrouter: { type: "api", key: "or-key" },
    });
    expect(await readJson(`${shared}.pragma.json`)).toEqual({ providers: {} });
    expect((await readJson(join(a, "auth.json")))["openai-codex"]).toEqual({
      type: "oauth",
      refresh: "a",
    });
  });

  it("signs a new, empty login in in place and keeps what it signs in to", async () => {
    const fresh = await home("fresh");
    await activate(fresh);
    expect(await readJson(shared)).toEqual({ openrouter: { type: "api", key: "or-key" } });
    // The harness's login command writes the new sign-in to the shared file.
    await writeJson(shared, {
      ...(await readJson(shared)),
      "openai-codex": { type: "oauth", refresh: "new" },
    });
    expect(await readLoginEntries(STORE, "openai", ENTRIES, { home: fresh, env })).toEqual({
      "openai-codex": { type: "oauth", refresh: "new" },
    });
    await activate(null);
    expect((await readJson(join(fresh, "auth.json")))["openai-codex"]).toEqual({
      type: "oauth",
      refresh: "new",
    });
    expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "own" });
  });

  it("leaves the shared file alone when the login is already active", async () => {
    await activate(null);
    expect(await readJson(shared)).toEqual({
      "openai-codex": { type: "oauth", refresh: "own" },
      openrouter: { type: "api", key: "or-key" },
    });
    await expect(stat(`${shared}.pragma.json`)).rejects.toThrow();
  });

  it("drops the entries of a login whose home was removed", async () => {
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    await activate(a);
    await rm(a, { recursive: true });
    await activate(null);
    expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "own" });
    await expect(stat(a)).rejects.toThrow();
  });

  describe("after a switch stopped between its writes", () => {
    const own = { "openai-codex": { type: "oauth", refresh: "own" } };

    /** The record a swap from the harness's own sign-in to `target` writes before the shared file. */
    async function recordSwitch(target: string): Promise<void> {
      await writeJson(`${shared}.pragma.json`, {
        providers: {
          openai: {
            active: null,
            own,
            switching: { target, outgoing: own, entries: ENTRIES },
          },
        },
      });
    }

    it("keeps the outgoing login when the shared file was never written", async () => {
      const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
      const b = await home("b", { "openai-codex": { type: "oauth", refresh: "b" } });
      await recordSwitch(a);
      expect(await readLoginEntries(STORE, "openai", ENTRIES, { home: null, env })).toEqual(own);
      await activate(b);
      // A's copy was never in the shared file, so it is never overwritten with the own sign-in.
      expect((await readJson(join(a, "auth.json")))["openai-codex"]).toEqual({
        type: "oauth",
        refresh: "a",
      });
      await activate(null);
      expect((await readJson(shared))["openai-codex"]).toEqual(own["openai-codex"]);
    });

    it("takes the switch as made when the shared file holds the target", async () => {
      const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
      await recordSwitch(a);
      await writeJson(shared, {
        "openai-codex": { type: "oauth", refresh: "a" },
        openrouter: { type: "api", key: "or-key" },
      });
      expect(await readLoginEntries(STORE, "openai", ENTRIES, { home: a, env })).toEqual({
        "openai-codex": { type: "oauth", refresh: "a" },
      });
      // Activating A again settles the switch without rewriting the file.
      await activate(a);
      expect((await readJson(`${shared}.pragma.json`)).providers).toEqual({
        openai: { active: a, own },
      });
      // The harness then rotates A's token, and the next switch saves it to A.
      const current = await readJson(shared);
      await writeJson(shared, { ...current, "openai-codex": { type: "oauth", refresh: "a2" } });
      await activate(null);
      expect((await readJson(join(a, "auth.json")))["openai-codex"]).toEqual({
        type: "oauth",
        refresh: "a2",
      });
      expect((await readJson(shared))["openai-codex"]).toEqual(own["openai-codex"]);
    });

    it("saves entries it cannot attribute to no login", async () => {
      const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
      await recordSwitch(a);
      await writeJson(shared, { "openai-codex": { type: "oauth", refresh: "unknown" } });
      await activate(a);
      // The saved copies stay as they were, and A's copy replaces the unknown entries.
      expect((await readJson(join(a, "auth.json")))["openai-codex"]).toEqual({
        type: "oauth",
        refresh: "a",
      });
      expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "a" });
      await activate(null);
      expect((await readJson(shared))["openai-codex"]).toEqual(own["openai-codex"]);
      expect(await readJson(`${shared}.pragma.json`)).toEqual({ providers: {} });
    });
  });

  it("clears a lock a crashed writer left behind", async () => {
    const lock = `${shared}.lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    await activate(a);
    expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "a" });
    await expect(stat(lock)).rejects.toThrow();
  });
});

describe("writeLoginEntries", () => {
  it("writes to the shared file while the login is active, else to its copy", async () => {
    const a = await home("a", { "openai-codex": { type: "oauth", refresh: "a" } });
    await activate(a);
    await writeLoginEntries(
      STORE,
      "openai",
      { home: a, env },
      {
        "openai-codex": { type: "oauth", refresh: "a2" },
      },
    );
    expect((await readJson(shared))["openai-codex"]).toEqual({ type: "oauth", refresh: "a2" });
    // The harness's own sign-in is set aside while A is active.
    await writeLoginEntries(
      STORE,
      "openai",
      { home: null, env },
      {
        "openai-codex": { type: "oauth", refresh: "own2" },
      },
    );
    expect(await readLoginEntries(STORE, "openai", ENTRIES, { home: null, env })).toEqual({
      "openai-codex": { type: "oauth", refresh: "own2" },
    });
    // A login that is not active, including a brand-new one, gets its own copy.
    const b = join(root, "accounts", "b");
    await writeLoginEntries(
      STORE,
      "openai",
      { home: b, env },
      {
        "openai-codex": { type: "oauth", refresh: "b" },
      },
    );
    expect((await readJson(join(b, "auth.json")))["openai-codex"]).toEqual({
      type: "oauth",
      refresh: "b",
    });
    expect(await readJson(shared)).toEqual({
      "openai-codex": { type: "oauth", refresh: "a2" },
      openrouter: { type: "api", key: "or-key" },
    });
  });
});

describe("credentialStoreAccount sharedToken", () => {
  const provider = credentialStoreAccount({
    provider: "openai",
    agent: "pi",
    store: STORE,
    entries: ENTRIES,
    switchable: true,
    login: { command: ["pi"] },
    sharedToken: { kind: "chatgpt", entry: "openai-codex", type: "oauth" },
  });
  const ctx = (homeDir: string | null) =>
    ({ account: { loginId: "x", home: homeDir, env } }) as Parameters<
      NonNullable<typeof provider.sharedToken>["read"]
    >[0];

  it("reads and writes the OAuth entry as a shared token", async () => {
    await writeJson(shared, {
      "openai-codex": { type: "oauth", access: "acc", refresh: "ref", expires: 5, accountId: "id" },
    });
    expect(provider.sharedToken?.kind).toBe("chatgpt");
    expect(await provider.sharedToken?.read(ctx(null))).toEqual({
      type: "oauth",
      access: "acc",
      refresh: "ref",
      expires: 5,
      accountId: "id",
    });
    const fresh = await home("fresh");
    await provider.sharedToken?.write?.(ctx(fresh), {
      type: "oauth",
      access: "a2",
      refresh: "r2",
      expires: 9,
    });
    expect((await readJson(join(fresh, "auth.json")))["openai-codex"]).toEqual({
      type: "oauth",
      access: "a2",
      refresh: "r2",
      expires: 9,
    });
  });

  it("reads an API key or a missing entry as signed out", async () => {
    await writeJson(shared, { "openai-codex": { type: "api", key: "sk" } });
    expect(await provider.sharedToken?.read(ctx(null))).toBeNull();
  });
});

describe("credentialStoreAccount default sharing", () => {
  const keyStore: CredentialStore = { ...STORE, apiKeyType: "api_key" };
  const ctx = (homeDir: string | null) => ({ account: { loginId: "x", home: homeDir, env } });

  it("shares the first entry's API key, in the store's own shape", async () => {
    const provider = credentialStoreAccount({
      provider: "openrouter",
      agent: "pi",
      store: keyStore,
      entries: ["openrouter"],
      apiKeyOnly: true,
    });
    expect(provider.swap).toBeDefined();
    expect(provider.sharedToken?.kind).toBe("key:openrouter");
    await writeJson(shared, { openrouter: { type: "api_key", key: "sk-or" } });
    expect(await provider.sharedToken?.read(ctx(null) as never)).toEqual({
      type: "api",
      key: "sk-or",
    });
    const fresh = await home("key");
    await provider.sharedToken?.write?.(ctx(fresh) as never, { type: "api", key: "sk-2" });
    expect((await readJson(join(fresh, "auth.json"))).openrouter).toEqual({
      type: "api_key",
      key: "sk-2",
    });
  });

  it("never lends a sign-in restricted to its own harness", async () => {
    const provider = credentialStoreAccount({
      provider: "anthropic",
      agent: "pi",
      store: STORE,
      entries: ["anthropic"],
      apiKeyOnly: true,
    });
    await writeJson(shared, { anthropic: { type: "oauth", access: "a", refresh: "r" } });
    expect(await provider.sharedToken?.read(ctx(null) as never)).toBeNull();
    const oauth = credentialStoreAccount({
      provider: "anthropic",
      agent: "pi",
      store: STORE,
      entries: ["anthropic"],
      apiKeyOnly: true,
      sharedToken: { kind: "claude", entry: "anthropic", type: "oauth" },
    });
    expect(oauth.sharedToken).toBeUndefined();
  });

  it("shares nothing when told not to", () => {
    const provider = credentialStoreAccount({
      provider: "openrouter",
      agent: "pi",
      store: STORE,
      entries: ["openrouter"],
      sharedToken: false,
    });
    expect(provider.sharedToken).toBeUndefined();
    expect(provider.swap).toBeUndefined();
  });
});
