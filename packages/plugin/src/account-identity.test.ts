import { describe, expect, it, vi } from "vitest";

import {
  apiKeyIdentity,
  chatGptIdentity,
  credentialStorePath,
  identifyFromCredentialStore,
  parseAnthropicProfile,
  storedCredentialIdentity,
} from "./account-identity";

/** This package is typed for the webview, so tests reach Node the same way the helpers do. */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule: (id: string) => unknown };
  }
).process.getBuiltinModule("node:fs") as {
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (path: string, data: string) => void;
};
const tmp = (
  globalThis as unknown as { process: { getBuiltinModule: (id: string) => unknown } }
).process.getBuiltinModule("node:os") as { tmpdir: () => string };

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function jwt(payload: Record<string, unknown>): string {
  return `${base64Url({ alg: "none" })}.${base64Url(payload)}.signature`;
}

const chatGptToken = jwt({
  "https://api.openai.com/profile": { email: "dev@example.com", name: "Dev" },
  "https://api.openai.com/auth": { chatgpt_account_id: "acct", chatgpt_plan_type: "plus" },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("chatGptIdentity", () => {
  it("uses the email as the id, matching Codex's account/read", () => {
    expect(chatGptIdentity(chatGptToken)).toEqual({
      id: "dev@example.com",
      email: "dev@example.com",
      name: "Dev",
      plan: "Plus",
    });
  });

  it("rejects tokens that are not a ChatGPT JWT", () => {
    expect(chatGptIdentity("sk-plain-key")).toBeNull();
    expect(chatGptIdentity(jwt({ sub: "x" }))).toBeNull();
  });
});

describe("parseAnthropicProfile", () => {
  it("builds the id Claude Code reports as orgId:email", () => {
    expect(
      parseAnthropicProfile({
        account: { email: "dev@example.com" },
        organization: { uuid: "org-1", name: "Acme" },
      }),
    ).toEqual({ id: "org-1:dev@example.com", email: "dev@example.com", name: "Acme" });
  });

  it("returns null without an account or organization", () => {
    expect(parseAnthropicProfile({})).toBeNull();
  });
});

describe("apiKeyIdentity", () => {
  it("identifies a key by digest, never by the key itself", async () => {
    const identity = await apiKeyIdentity("sk-secret-1234");
    expect(identity?.id).toMatch(/^key:[0-9a-f]{16}$/);
    expect(identity?.id).not.toContain("secret");
    expect(identity?.name).toBe("API key …1234");
    expect(await apiKeyIdentity("sk-secret-1234")).toEqual(identity);
    expect(await apiKeyIdentity("  ")).toBeNull();
  });
});

describe("storedCredentialIdentity", () => {
  it("decodes an OpenAI OAuth entry offline", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const identity = await storedCredentialIdentity(
      "openai",
      { type: "oauth", access: chatGptToken, refresh: "r" },
      fetcher,
    );
    expect(identity?.id).toBe("dev@example.com");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("identifies a Copilot entry through its GitHub token", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ login: "OctoCat" }));
    const identity = await storedCredentialIdentity(
      "github-copilot",
      { type: "oauth", access: "copilot", refresh: "ghu_token" },
      fetcher,
    );
    expect(identity).toEqual({ id: "octocat" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer ghu_token",
    });
  });

  it("reports null when the provider rejects an expired token", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({}, 401));
    expect(
      await storedCredentialIdentity("anthropic", { type: "oauth", access: "old" }, fetcher),
    ).toBeNull();
  });

  it("identifies API-key entries in either store's spelling", async () => {
    const api = await storedCredentialIdentity("opencode-go", { type: "api", key: "k-1" });
    const apiKey = await storedCredentialIdentity("opencode-go", { type: "api_key", key: "k-1" });
    expect(api?.id).toBe(apiKey?.id);
  });

  it("returns null for a missing entry", async () => {
    expect(await storedCredentialIdentity("openai", undefined)).toBeNull();
  });
});

describe("identifyFromCredentialStore", () => {
  const store = { dirEnv: "PRAGMA_TEST_STORE_DIR", defaultDir: "~/.nowhere", file: "auth.json" };

  it("reads the entry from the login's directory", async () => {
    const dir = fs.mkdtempSync(`${tmp.tmpdir()}/pragma-store-`);
    fs.writeFileSync(
      `${dir}/auth.json`,
      JSON.stringify({ "openai-codex": { type: "oauth", access: chatGptToken } }),
    );
    const identify = identifyFromCredentialStore(store, "openai-codex", "openai");
    const account = { loginId: "x", home: dir, env: { PRAGMA_TEST_STORE_DIR: dir } };
    expect((await identify({ account }))?.id).toBe("dev@example.com");
  });

  it("reports signed out when the file is missing", async () => {
    const identify = identifyFromCredentialStore(store, "openai-codex", "openai");
    const account = { loginId: "x", home: null, env: { PRAGMA_TEST_STORE_DIR: "/nonexistent" } };
    expect(await identify({ account })).toBeNull();
  });

  it("never identifies an OAuth sign-in for a key-only provider", async () => {
    const dir = fs.mkdtempSync(`${tmp.tmpdir()}/pragma-store-`);
    fs.writeFileSync(
      `${dir}/auth.json`,
      JSON.stringify({ anthropic: { type: "oauth", access: "subscription-token" } }),
    );
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      const identify = identifyFromCredentialStore(store, "anthropic", "anthropic", {
        apiKeyOnly: true,
      });
      const account = { loginId: "x", home: dir, env: { PRAGMA_TEST_STORE_DIR: dir } };
      expect(await identify({ account })).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes the first entry that identifies", async () => {
    const dir = fs.mkdtempSync(`${tmp.tmpdir()}/pragma-store-`);
    fs.writeFileSync(`${dir}/auth.json`, JSON.stringify({ "zai-cn": { type: "api", key: "k-9" } }));
    const identify = identifyFromCredentialStore(store, ["zai", "zai-cn"], "zai");
    const account = { loginId: "x", home: dir, env: { PRAGMA_TEST_STORE_DIR: dir } };
    expect(await identify({ account })).toEqual(await apiKeyIdentity("k-9"));
  });

  it("describes the default location for display", () => {
    expect(credentialStorePath(store, null)).toBe("$PRAGMA_TEST_STORE_DIR or ~/.nowhere/auth.json");
    expect(credentialStorePath(store, "/h")).toBe("/h/auth.json");
  });
});
