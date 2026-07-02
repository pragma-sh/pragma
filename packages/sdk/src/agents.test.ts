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
});
