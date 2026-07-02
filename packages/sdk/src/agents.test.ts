import { describe, expect, it } from "vitest";

import { reportStarted } from "./agents-client";
import { PragmaClient } from "./client";
import { PRAGMA_ENV_KEYS } from "./env";

describe("agents", () => {
  it("no-ops outside Pragma", async () => {
    await expect(reportStarted({ agent: "opencode", env: {} })).resolves.toBeUndefined();
  });

  it("builds report payload", async () => {
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await reportStarted({
      agent: "opencode",
      client,
      env: {
        [PRAGMA_ENV_KEYS.tabId]: "tab",
        [PRAGMA_ENV_KEYS.worktreeId]: "worktree",
      },
    });

    expect(JSON.parse(body)).toEqual({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      status: "running",
      attentionKind: null,
    });
  });

  it("uses gateway credentials from custom env for fallback reports", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
      await reportStarted({
        agent: "opencode",
        env: {
          [PRAGMA_ENV_KEYS.gatewayUrl]: "http://127.0.0.1:1234",
          [PRAGMA_ENV_KEYS.gatewayToken]: "token-from-env",
          [PRAGMA_ENV_KEYS.tabId]: "tab",
          [PRAGMA_ENV_KEYS.worktreeId]: "worktree",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const call = calls[0];
    if (!call?.init) {
      throw new Error("expected fallback report to call fetch");
    }
    expect(call.input).toBe("http://127.0.0.1:1234/v1/agents/reports");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer token-from-env",
    );
  });
});
