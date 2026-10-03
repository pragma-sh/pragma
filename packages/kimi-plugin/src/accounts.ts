import {
  apiKeyIdentity,
  apiKeyTokenKind,
  modelsDevAccountProviders,
  type AccountContext,
  type AccountIdentity,
  type AccountProviderDefinition,
  type ModelsDevAccountProvider,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { KIMI_BIN_DIR, KIMI_MODELS_COMMAND, recordValue } from "./models";

/** How long one `kimi provider list` answers every provider's `identify`. */
const PROVIDER_LIST_TTL_MS = 5_000;
/** The catalog is models.dev, fetched over the network: ask rarely. */
const CATALOG_TTL_MS = 10 * 60_000;
/** Past this, an offline or slow catalog fetch stops holding up the account list. */
const CATALOG_TIMEOUT_MS = 10_000;
/** Every provider `kimi provider catalog add` can import, as JSON keyed by models.dev id. */
const KIMI_CATALOG_COMMAND = `kimi provider catalog list --json || "${KIMI_BIN_DIR}/kimi" provider catalog list --json`;

/**
 * API-key providers Kimi Code can hold, besides its own Kimi sign-in
 * (`moonshot`, declared with `kimi login`). `kimi provider catalog add <id>`
 * imports them from models.dev under that id, so they are matched the same
 * way OpenCode's are.
 */
export const KIMI_API_KEY_PROVIDERS: ModelsDevAccountProvider[] = modelsDevAccountProviders([
  "moonshot",
]);

/** Kimi Code's configured providers: id → API key. Never logged or returned. */
type ProviderKeys = ReadonlyMap<string, string>;

const providerLists = new Map<string, { at: number; keys: Promise<ProviderKeys> }>();
let catalog: { at: number; ids: Promise<ReadonlySet<string> | null> } | undefined;

/**
 * One account provider per API-key provider in Kimi Code's `config.toml`.
 *
 * Each follows Kimi's own config (no `env`): only `moonshot` may relocate
 * `KIMI_CODE_HOME`, and two providers setting it would fight at launch. Keys
 * are added with `kimi provider catalog add <id> --api-key …`, so there is no
 * login command. `identify` digests the key — never the key itself. A
 * provider is listed only while Kimi's own catalog still offers one of its ids.
 */
export function kimiApiKeyProviders(): AccountProviderDefinition[] {
  return KIMI_API_KEY_PROVIDERS.map(({ provider, modelsDevIds }) => ({
    provider,
    agent: "kimi",
    credentialPath: () => "$KIMI_CODE_HOME or ~/.kimi-code/config.toml",
    available: (ctx) => kimiOffers(ctx, modelsDevIds),
    identify: (ctx) => identifyKimiProvider(ctx, modelsDevIds),
    // Kimi lends its keys to other harnesses but takes none: its config is
    // written through `kimi provider catalog add`, which would put the key on
    // a command line, and it has no per-account slot to put a copy in.
    sharedToken: {
      kind: apiKeyTokenKind(provider),
      read: async (ctx) => {
        const key = await kimiProviderKey(ctx, modelsDevIds);
        return key ? { type: "api", key } : null;
      },
    },
  }));
}

/**
 * Whether `kimi provider catalog add` can import any of these ids. Kimi's
 * answer when it gives one; when it cannot (offline, not installed), the
 * declaration stands.
 */
async function kimiOffers(ctx: PluginContext, modelsDevIds: readonly string[]): Promise<boolean> {
  const ids = await catalogIds(ctx);
  return ids === null || modelsDevIds.some((id) => ids.has(id));
}

/**
 * Kimi's catalog ids, one listing shared by every provider for a while. A
 * failed listing is not kept, so the next account refresh asks again.
 */
function catalogIds(ctx: PluginContext): Promise<ReadonlySet<string> | null> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.ids;
  const ids = listCatalogIds(ctx);
  const entry = { at: Date.now(), ids };
  catalog = entry;
  void ids.then((result) => {
    if (result === null && catalog === entry) catalog = undefined;
    return undefined;
  });
  return ids;
}

/** Forgets the cached catalog; for tests. */
export function resetKimiCatalogCache(): void {
  catalog = undefined;
}

async function listCatalogIds(ctx: PluginContext): Promise<ReadonlySet<string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_TIMEOUT_MS);
  });
  const listing = ctx.sdk.exec
    .run({ cwd: ctx.project?.path ?? "/tmp", commands: [KIMI_CATALOG_COMMAND] })
    .then(([result]) => parseKimiCatalogIds(result?.stdout ?? ""))
    .catch(() => null);
  try {
    return await Promise.race([listing, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The provider ids in `kimi provider catalog list --json`, or null when unreadable. */
export function parseKimiCatalogIds(output: string): ReadonlySet<string> | null {
  try {
    const providers = recordValue(JSON.parse(output));
    return providers && Object.keys(providers).length > 0 ? new Set(Object.keys(providers)) : null;
  } catch {
    return null;
  }
}

async function identifyKimiProvider(
  ctx: AccountContext,
  modelsDevIds: readonly string[],
): Promise<AccountIdentity | null> {
  const key = await kimiProviderKey(ctx, modelsDevIds);
  return key ? apiKeyIdentity(key) : null;
}

/** The first of a provider's models.dev ids Kimi holds a key for. Never logged. */
async function kimiProviderKey(
  ctx: AccountContext,
  modelsDevIds: readonly string[],
): Promise<string | null> {
  const keys = await providerKeys(ctx);
  for (const id of modelsDevIds) {
    const key = keys.get(id);
    if (key) return key;
  }
  return null;
}

/**
 * Kimi's providers through its supported CLI, which applies `KIMI_CODE_HOME`
 * and its own config rules. Every provider identifies at once, so one listing
 * per login env is shared for a few seconds instead of running Kimi per row.
 */
function providerKeys(ctx: AccountContext): Promise<ProviderKeys> {
  const cacheKey = JSON.stringify([ctx.project?.path ?? null, ctx.account.env]);
  const cached = providerLists.get(cacheKey);
  if (cached && Date.now() - cached.at < PROVIDER_LIST_TTL_MS) return cached.keys;
  const keys = listProviderKeys(ctx);
  providerLists.set(cacheKey, { at: Date.now(), keys });
  return keys;
}

async function listProviderKeys(ctx: AccountContext): Promise<ProviderKeys> {
  try {
    const [result] = await ctx.sdk.exec.run({
      cwd: ctx.project?.path ?? "/tmp",
      commands: [KIMI_MODELS_COMMAND],
    });
    return parseKimiProviderKeys(result?.stdout ?? "");
  } catch {
    return new Map();
  }
}

/** Reads each provider's API key from `kimi provider list --json`. */
export function parseKimiProviderKeys(output: string): ProviderKeys {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return new Map();
  }
  const keys = new Map<string, string>();
  for (const [id, candidate] of Object.entries(recordValue(recordValue(value)?.providers) ?? {})) {
    const apiKey = recordValue(candidate)?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) keys.set(id, apiKey.trim());
  }
  return keys;
}
