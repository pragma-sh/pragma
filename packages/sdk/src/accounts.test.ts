import { describe, expect, it, vi } from "vitest";

import { AccountsApi } from "./accounts-client";

describe("AccountsApi", () => {
  it("sends the shared request shape for every call", async () => {
    const send = vi.fn(async () => ({ env: [] }));
    const api = new AccountsApi(send);
    await api.launchEnv({ agentId: "pragma.claude-code", projectRoot: "/repo", tabId: "t1" });
    await api.setBinding({
      agentId: "pragma.claude-code",
      provider: "anthropic",
      accountKey: "anthropic:org",
      scope: "global",
    });
    expect(send.mock.calls).toEqual([
      [{ action: "launchEnv", agentId: "pragma.claude-code", projectRoot: "/repo", tabId: "t1" }],
      [
        {
          action: "setBinding",
          agentId: "pragma.claude-code",
          provider: "anthropic",
          accountKey: "anthropic:org",
          scope: "global",
        },
      ],
    ]);
  });
});
