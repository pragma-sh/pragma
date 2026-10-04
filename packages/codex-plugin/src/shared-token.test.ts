import { describe, expect, it } from "vitest";

import { codexAuth, parseCodexAuth } from "./shared-token";

function part(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function jwt(payload: Record<string, unknown>): string {
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}

const access = jwt({ iat: 1_790_000_000, exp: 1_790_864_000 });

describe("parseCodexAuth", () => {
  it("reads Codex's tokens with the access token's expiry", () => {
    expect(
      parseCodexAuth({
        auth_mode: "chatgpt",
        tokens: { id_token: "id", access_token: access, refresh_token: "r", account_id: "acc" },
      }),
    ).toEqual({
      type: "oauth",
      access,
      refresh: "r",
      expires: 1_790_864_000_000,
      accountId: "acc",
      idToken: "id",
    });
  });

  it("is null when signed out", () => {
    expect(parseCodexAuth(null)).toBeNull();
    expect(parseCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk" })).toBeNull();
  });
});

describe("codexAuth", () => {
  it("keeps Codex's own id token for a token from a harness that drops it", () => {
    const auth = codexAuth(
      {
        auth_mode: "chatgpt",
        tokens: { id_token: "kept", access_token: "old", refresh_token: "old" },
      },
      { type: "oauth", access, refresh: "new", expires: 1, accountId: "acc" },
    );
    expect(auth).toEqual({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: "kept", access_token: access, refresh_token: "new", account_id: "acc" },
      // When the access token was issued, so Codex refreshes on its usual schedule.
      last_refresh: new Date(1_790_000_000_000).toISOString(),
    });
  });

  it("refuses a sign-in Codex could not use", () => {
    expect(() => codexAuth(null, { type: "oauth", access, refresh: "r", expires: 1 })).toThrow(
      /own ChatGPT/,
    );
    expect(() => codexAuth(null, { type: "api", key: "sk" })).toThrow(/only a ChatGPT/);
  });
});
