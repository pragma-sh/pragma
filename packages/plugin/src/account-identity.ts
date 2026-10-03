/**
 * Canonical identities for well-known account providers.
 *
 * Pragma merges logins into one account when their `identify` returns the same
 * id, so every harness that signs in to a well-known provider has to derive
 * that id the same way. These helpers are that one derivation: a harness that
 * stores the provider's credential itself (OpenCode, Pi, …) reads it and passes
 * it here, and the result matches what the provider's own CLI reports.
 *
 * None of them refresh a token. Several providers rotate refresh tokens, so
 * using one without writing the new one back would sign the harness out.
 */
import type {
  AccountContext,
  AccountIdentity,
  AccountLogin,
  AccountProviderDefinition,
  AccountSharedToken,
  SharedToken,
  WellKnownAccountProvider,
} from "./accounts";
import { apiKeyTokenKind } from "./accounts";
import {
  activateCredentialSwap,
  loginCredentialFile,
  readLoginEntries,
  writeLoginEntries,
} from "./credential-swap";
import { expandHome, hostBuiltin, hostProcess, recordValue } from "./host";

const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const GITHUB_USER_URL = "https://api.github.com/user";
/** Hex characters of the key digest kept in an API-key identity. */
const API_KEY_DIGEST_LENGTH = 16;

/**
 * The ChatGPT account a Codex-style OAuth token belongs to, decoded offline.
 *
 * The id is the account email, which is what Codex's `account/read` reports,
 * so an OpenCode or Pi login merges with the same Codex account. Identity
 * claims stay readable after the token expires.
 */
export function chatGptIdentity(accessToken: string): AccountIdentity | null {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return null;
  const profile = recordValue(claims[CHATGPT_PROFILE_CLAIM]);
  const auth = recordValue(claims[CHATGPT_AUTH_CLAIM]);
  const email = stringValue(profile?.email);
  if (!email) return null;
  const name = stringValue(profile?.name);
  const plan = stringValue(auth?.chatgpt_plan_type);
  return {
    id: email,
    email,
    ...(name ? { name } : {}),
    ...(plan ? { plan: capitalize(plan) } : {}),
  };
}

/**
 * The Claude account an Anthropic OAuth access token belongs to.
 *
 * The id is `<organization uuid>:<email>`, matching `claude auth status`
 * (`orgId`, `email`). Returns null when the token is rejected — typically
 * because it expired and only the harness itself may refresh it.
 */
export async function anthropicOAuthIdentity(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountIdentity | null> {
  const response = await fetcher(ANTHROPIC_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    },
  });
  if (!response.ok) return null;
  return parseAnthropicProfile(await response.json());
}

/** Parses Anthropic's `/api/oauth/profile` response into an identity. */
export function parseAnthropicProfile(value: unknown): AccountIdentity | null {
  const account = recordValue(recordValue(value)?.account);
  const organization = recordValue(recordValue(value)?.organization);
  const email = stringValue(account?.email);
  const orgId = stringValue(organization?.uuid);
  const id = orgId && email ? `${orgId}:${email}` : (orgId ?? email);
  if (!id) return null;
  const name = stringValue(organization?.name);
  return { id, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

/**
 * The GitHub user a GitHub OAuth token (the one Copilot is reached through)
 * belongs to. The id is the lowercased login, matching Copilot CLI's
 * `logged_in_users`.
 */
export async function gitHubIdentity(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountIdentity | null> {
  const response = await fetcher(GITHUB_USER_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  const user = recordValue(await response.json());
  const login = stringValue(user?.login);
  if (!login) return null;
  const name = stringValue(user?.name);
  const email = stringValue(user?.email);
  return { id: login.toLowerCase(), ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

/**
 * An identity for an API-key login: a digest of the key, never the key.
 *
 * Two harnesses holding the same key are one account; the name shows the last
 * four characters so the user can tell keys apart.
 */
export async function apiKeyIdentity(key: string): Promise<AccountIdentity | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, API_KEY_DIGEST_LENGTH);
  return { id: `key:${hex}`, name: `API key …${trimmed.slice(-4)}` };
}

/**
 * Where a harness keeps its credentials: `envVar` from the login's env, then
 * from the host's env, else `fallback` (a `~`-relative path is expanded).
 * Only callable on the host — it reads the host's home directory.
 */
export async function credentialDir(
  ctx: Pick<AccountContext, "account">,
  envVar: string,
  fallback: string,
): Promise<string> {
  const configured = ctx.account.env[envVar] ?? hostProcess()?.env?.[envVar];
  if (configured) return configured;
  return expandHome(fallback);
}

/**
 * Reads a harness's JSON credential file on the host, or null when it is
 * missing or unreadable. The file is read in the plugins sidecar, so tokens
 * never travel through `exec`.
 */
export async function readCredentialFile(path: string): Promise<Record<string, unknown> | null> {
  const { readFile } = hostBuiltin<{
    readFile: (path: string, encoding: "utf8") => Promise<string>;
  }>("node:fs/promises");
  try {
    return recordValue(JSON.parse(await readFile(await expandHome(path), "utf8"))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Writes a harness's JSON credential file on the host, owner-only, creating
 * its directory. Like {@link readCredentialFile}, tokens never travel through
 * `exec`.
 */
export async function writeCredentialFile(path: string, value: unknown): Promise<void> {
  const fs = hostBuiltin<{
    mkdir: (path: string, options: { recursive: boolean; mode: number }) => Promise<unknown>;
    writeFile: (path: string, data: string, options: { mode: number }) => Promise<void>;
    chmod: (path: string, mode: number) => Promise<void>;
  }>("node:fs/promises");
  const target = await expandHome(path);
  const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  if (slash > 0) await fs.mkdir(target.slice(0, slash), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(target, 0o600);
}

/** The claims of a JWT (e.g. an OAuth access token), decoded without verifying it. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  return decodeJwtPayload(token);
}

/** Where a harness that holds several providers keeps them: one JSON file keyed by provider. */
export interface CredentialStore {
  /** Env var that relocates the harness's data directory, e.g. `PI_CODING_AGENT_DIR`. */
  dirEnv: string;
  /** Directory used when `dirEnv` is unset; `~`-relative paths are expanded. */
  defaultDir: string;
  /** The JSON file inside that directory, e.g. `auth.json` or `opencode/auth.json`. */
  file: string;
  /** The `type` the harness writes on an API-key entry: OpenCode `api` (default), Pi `api_key`. */
  apiKeyType?: string;
}

/** Display path of a store's credential file, for `credentialPath`. */
export function credentialStorePath(store: CredentialStore, home: string | null): string {
  return `${home ?? `$${store.dirEnv} or ${store.defaultDir}`}/${store.file}`;
}

/** How `identifyFromCredentialStore` treats a stored entry. */
export interface StoredCredentialOptions {
  /**
   * Identify only API keys, never an OAuth sign-in. Set it for a provider whose
   * subscription OAuth may only be used in its own first-party harness (Claude
   * Free/Pro/Max, Gemini CLI or Antigravity): Pragma must not present such a
   * sign-in in another harness as a usable account.
   */
  apiKeyOnly?: boolean;
}

/**
 * An `identify` callback for one provider's entry in a harness's credential
 * store, e.g. the `openai` entry of OpenCode's `auth.json`. Given several
 * entry keys (a provider's global and regional endpoints, say), the first one
 * that identifies wins. Signed out, or an entry that cannot be identified,
 * reports null.
 */
export function identifyFromCredentialStore(
  store: CredentialStore,
  entryKey: string | readonly string[],
  provider: WellKnownAccountProvider | (string & {}),
  options: StoredCredentialOptions = {},
): (ctx: Pick<AccountContext, "account">) => Promise<AccountIdentity | null> {
  const entryKeys = typeof entryKey === "string" ? [entryKey] : entryKey;
  return async (ctx) => {
    const dir = await credentialDir(ctx, store.dirEnv, store.defaultDir);
    const credentials = await readCredentialFile(`${dir}/${store.file}`);
    return identifyEntries(provider, credentials, entryKeys, options.apiKeyOnly ?? false);
  };
}

/** One provider held in a multi-provider harness's credential store. */
export interface CredentialStoreAccountOptions extends StoredCredentialOptions {
  /** Well-known key (see `ACCOUNT_PROVIDERS`) or a plugin-specific one. */
  provider: WellKnownAccountProvider | (string & {});
  /** The plugin's agent id that holds the credential. */
  agent: string;
  store: CredentialStore;
  /** The provider's entry keys in the store, most specific first. */
  entries: readonly string[];
  /** How Pragma signs the harness in to it, when the harness has a login command. */
  login?: AccountLogin;
  /**
   * Allow several accounts by swapping this provider's entries in and out of
   * the shared store at launch (see `AccountSwap`). Each login keeps its copy
   * in its Pragma-owned home while another one is active. Defaults to on
   * whenever the provider shares its sign-in (the default), so a copy has a
   * login of its own.
   */
  switchable?: boolean;
  /**
   * What other harnesses can borrow (see `AccountSharedToken`). By default the
   * first entry's API key, as kind `key:<provider>`. Pass an OAuth entry and
   * its kind (named after the OAuth client) to share a sign-in instead, e.g.
   * `{ kind: "chatgpt", entry: "openai", type: "oauth" }`, or `false` to share
   * nothing. An `apiKeyOnly` provider never shares an OAuth entry.
   */
  sharedToken?: StoredSharedTokenOptions | false;
}

/** Which store entry a provider shares, and as what. */
export interface StoredSharedTokenOptions {
  kind: string;
  entry: string;
  type: SharedToken["type"];
}

/**
 * An account provider for one provider held in a multi-provider harness's
 * credential store. It identifies the stored entry so it merges with the same
 * account in other harnesses.
 *
 * By default it follows the harness's own sign-in (no `env`): every provider
 * shares the harness's one store, so none of them can own a credential
 * directory. With `switchable` it swaps this provider's entries in and out of
 * that store at launch instead, so the harness can hold several accounts.
 */
export function credentialStoreAccount(
  options: CredentialStoreAccountOptions,
): AccountProviderDefinition {
  const { store, entries, provider } = options;
  const apiKeyOnly = options.apiKeyOnly ?? false;
  const shared = sharedTokenOptions(options);
  const base: AccountProviderDefinition = {
    provider,
    agent: options.agent,
    ...(options.login ? { login: options.login } : {}),
    credentialPath: (home) =>
      home === null ? credentialStorePath(store, null) : loginCredentialFile(store, home),
  };
  if (!(options.switchable ?? shared !== null)) {
    return {
      ...base,
      identify: identifyFromCredentialStore(store, entries, provider, { apiKeyOnly }),
    };
  }
  return {
    ...base,
    swap: {
      activate: (ctx) => activateCredentialSwap(store, provider, entries, ctx.account),
    },
    identify: async (ctx) => {
      const stored = await readLoginEntries(store, provider, entries, ctx.account);
      return identifyEntries(provider, stored, entries, apiKeyOnly);
    },
    ...(shared
      ? {
          sharedToken: {
            kind: shared.kind,
            read: async (ctx) => {
              const stored = await readLoginEntries(store, provider, entries, ctx.account);
              // A key may sit under any of the provider's entries; a declared
              // OAuth sign-in only under its own.
              const keys = options.sharedToken ? [shared.entry] : entries;
              for (const key of keys) {
                const token = entryToken(stored?.[key], shared.type);
                if (token) return token;
              }
              return null;
            },
            write: (ctx, token) =>
              writeLoginEntries(store, provider, ctx.account, {
                [shared.entry]: tokenEntry(token, shared.type, store),
              }),
          },
        }
      : {}),
  };
}

/** The entry a provider shares: the caller's, else its first entry's API key. */
function sharedTokenOptions(
  options: CredentialStoreAccountOptions,
): StoredSharedTokenOptions | null {
  if (options.sharedToken === false) return null;
  const shared = options.sharedToken ?? {
    kind: apiKeyTokenKind(options.provider),
    entry: options.entries[0] ?? options.provider,
    type: "api" as const,
  };
  // A sign-in restricted to its own harness is never lent out.
  return shared.type === "oauth" && options.apiKeyOnly ? null : shared;
}

/**
 * An `{ type, … }` entry in a JSON credential store (OpenCode, Pi) as a
 * shared token of `type`, or null when it holds something else.
 */
export function entryToken(entry: unknown, type: SharedToken["type"]): SharedToken | null {
  const credential = recordValue(entry);
  if (!credential) return null;
  if (type === "api") {
    if (credential.type === "oauth") return null;
    const key = stringValue(credential.key);
    return key ? { type: "api", key } : null;
  }
  return oauthEntryToken(credential);
}

/** A shared token as an entry in `store`'s own shape. */
export function tokenEntry(
  token: SharedToken,
  type: SharedToken["type"],
  store: Pick<CredentialStore, "apiKeyType">,
): Record<string, unknown> {
  if (token.type !== type) {
    throw new Error(`expected a shared ${type} token, got ${token.type}`);
  }
  if (token.type === "api") return { type: store.apiKeyType ?? "api", key: token.key };
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    ...(token.accountId ? { accountId: token.accountId } : {}),
  };
}

/**
 * Shares one entry of a provider whose logins are whole data directories
 * (`env`), e.g. OpenCode Go: a Pragma login's `<home>/<file>`, else the
 * harness's own store.
 */
export function credentialFileSharedToken(
  store: CredentialStore,
  shared: StoredSharedTokenOptions,
): AccountSharedToken {
  const path = async (ctx: Pick<AccountContext, "account">) =>
    ctx.account.home === null
      ? `${await credentialDir(ctx, store.dirEnv, store.defaultDir)}/${store.file}`
      : loginCredentialFile(store, ctx.account.home);
  return {
    kind: shared.kind,
    read: async (ctx) =>
      entryToken((await readCredentialFile(await path(ctx)))?.[shared.entry], shared.type),
    write: async (ctx, token) => {
      const file = await path(ctx);
      const current = (await readCredentialFile(file)) ?? {};
      await writeCredentialFile(file, {
        ...current,
        [shared.entry]: tokenEntry(token, shared.type, store),
      });
    },
  };
}

/** An OpenCode/Pi-style `{ type: "oauth", access, refresh, expires }` entry as a shared token. */
function oauthEntryToken(entry: unknown): SharedToken | null {
  const credential = recordValue(entry);
  if (credential?.type !== "oauth") return null;
  const access = stringValue(credential.access);
  const refresh = stringValue(credential.refresh);
  if (!access || !refresh) return null;
  const expires = typeof credential.expires === "number" ? credential.expires : 0;
  const accountId = stringValue(credential.accountId);
  return { type: "oauth", access, refresh, expires, ...(accountId ? { accountId } : {}) };
}

/** The first of `entries` in `stored` that identifies, in order. */
async function identifyEntries(
  provider: WellKnownAccountProvider | (string & {}),
  stored: Record<string, unknown> | null,
  entries: readonly string[],
  apiKeyOnly: boolean,
): Promise<AccountIdentity | null> {
  for (const key of entries) {
    const entry = stored?.[key];
    if (apiKeyOnly && recordValue(entry)?.type === "oauth") continue;
    // Sequential on purpose: the first entry wins, and identifying one may
    // call the provider's API.
    // oxlint-disable-next-line no-await-in-loop
    const identity = await storedCredentialIdentity(provider, entry);
    if (identity) return identity;
  }
  return null;
}

/**
 * The identity of one stored credential entry, in the shape OpenCode and Pi
 * both write: `{ type: "oauth", access, refresh }` or `{ type: "api" |
 * "api_key", key }`. OAuth entries are identified the provider's way; any key
 * is identified by its digest.
 */
export async function storedCredentialIdentity(
  provider: WellKnownAccountProvider | (string & {}),
  entry: unknown,
  fetcher: typeof fetch = fetch,
): Promise<AccountIdentity | null> {
  const credential = recordValue(entry);
  if (!credential) return null;
  const key = stringValue(credential.key);
  if (credential.type !== "oauth") return key ? apiKeyIdentity(key) : null;
  const access = stringValue(credential.access);
  const refresh = stringValue(credential.refresh);
  switch (provider) {
    case "openai":
      return access ? chatGptIdentity(access) : null;
    case "anthropic":
      return access ? anthropicOAuthIdentity(access, fetcher) : null;
    case "github-copilot":
      // The refresh field holds the GitHub token; the access field is a
      // short-lived Copilot token. Enterprise hosts are not github.com.
      return refresh && !credential.enterpriseUrl ? gitHubIdentity(refresh, fetcher) : null;
    default:
      return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return recordValue(JSON.parse(new TextDecoder().decode(bytes))) ?? null;
  } catch {
    return null;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
