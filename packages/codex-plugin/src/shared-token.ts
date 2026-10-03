import {
  credentialDir,
  jwtClaims,
  readCredentialFile,
  writeCredentialFile,
  type AccountContext,
  type AccountSharedToken,
  type SharedToken,
} from "@pragma-sh/plugin/catalog";

/**
 * Codex's ChatGPT sign-in as a shared `chatgpt` token. OpenCode, Pi, and Prime
 * Agent sign in through the same OAuth client, so an account signed in here
 * can be handed to them (and back) without signing in again.
 */
export const codexSharedToken: AccountSharedToken = {
  kind: "chatgpt",
  read: async (ctx) => parseCodexAuth(await readCredentialFile(await codexAuthPath(ctx))),
  write: async (ctx, token) => {
    const path = await codexAuthPath(ctx);
    await writeCredentialFile(path, codexAuth(await readCredentialFile(path), token));
  },
};

/** `$CODEX_HOME/auth.json` for the login: its Pragma home, else Codex's own. */
async function codexAuthPath(ctx: Pick<AccountContext, "account">): Promise<string> {
  const dir = ctx.account.home ?? (await credentialDir(ctx, "CODEX_HOME", "~/.codex"));
  return `${dir}/auth.json`;
}

/** Reads Codex's `auth.json` (`tokens.access_token`, …) as a shared token. */
export function parseCodexAuth(auth: Record<string, unknown> | null): SharedToken | null {
  const tokens = record(auth?.tokens);
  const access = text(tokens?.access_token);
  const refresh = text(tokens?.refresh_token);
  if (!access || !refresh) return null;
  const accountId = text(tokens?.account_id);
  const idToken = text(tokens?.id_token);
  return {
    type: "oauth",
    access,
    refresh,
    expires: claimMs(access, "exp") ?? 0,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

/**
 * Codex's `auth.json` holding `token`, keeping what Codex alone records.
 *
 * Codex needs an `id_token`, which OpenCode and Pi do not keep: a token from
 * them reuses the one already here (same account, so the same claims). Without
 * either, Codex cannot use the sign-in. `last_refresh` is when the access token
 * was issued, so Codex refreshes it on its usual schedule.
 */
export function codexAuth(
  existing: Record<string, unknown> | null,
  token: SharedToken,
): Record<string, unknown> {
  if (token.type !== "oauth") throw new Error("Codex shares only a ChatGPT sign-in");
  const previous = record(existing?.tokens);
  const idToken = token.idToken ?? text(previous?.id_token);
  if (!idToken) {
    throw new Error("Codex needs its own ChatGPT sign-in before it can share one");
  }
  const issued = claimMs(token.access, "iat");
  return {
    ...existing,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: existing?.OPENAI_API_KEY ?? null,
    tokens: {
      ...previous,
      id_token: idToken,
      access_token: token.access,
      refresh_token: token.refresh,
      ...(token.accountId ? { account_id: token.accountId } : {}),
    },
    last_refresh: new Date(issued ?? Date.now()).toISOString(),
  };
}

function claimMs(token: string, claim: "exp" | "iat"): number | null {
  const value = jwtClaims(token)?.[claim];
  return typeof value === "number" ? value * 1000 : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
