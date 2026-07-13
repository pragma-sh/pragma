import { describe, expect, it } from "vitest";

import { PRAGMA_ENV_KEYS, hasPragmaEnvironment, readEnv } from "./env";

describe("env", () => {
  it("reads injected env", () => {
    expect(readEnv("NAME", { NAME: "value" })).toBe("value");
  });

  it("detects a Pragma gateway session", () => {
    expect(
      hasPragmaEnvironment({
        [PRAGMA_ENV_KEYS.gatewayUrl]: "http://127.0.0.1:1",
        [PRAGMA_ENV_KEYS.gatewayToken]: "token",
        [PRAGMA_ENV_KEYS.tabId]: "tab",
        [PRAGMA_ENV_KEYS.worktreeId]: "worktree",
      }),
    ).toBe(true);
    expect(
      hasPragmaEnvironment({
        [PRAGMA_ENV_KEYS.gatewayUrl]: "",
        [PRAGMA_ENV_KEYS.gatewayToken]: "",
        [PRAGMA_ENV_KEYS.tabId]: "",
        [PRAGMA_ENV_KEYS.worktreeId]: "",
      }),
    ).toBe(false);
  });
});
