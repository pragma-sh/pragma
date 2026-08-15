import { describe, expect, it, vi } from "vitest";

import { primeAgentPlugin } from "./pragma-plugin";

describe("Prime Agent plugin", () => {
  it("launches Prime Agent with matching watcher identity", () => {
    // `--no-session` marks the session client-owned, which makes the CLI send
    // its full environment (PRAGMA_* included) to the daemon worker; without
    // it a pre-existing prime-agent daemon strips those vars and the Pragma
    // extension never reports status.
    expect(primeAgentPlugin.agents?.[0]).toMatchObject({
      id: "prime-agent",
      name: "Prime Agent",
      launch: { command: ["prime-agent", "--no-session"] },
    });
    expect(primeAgentPlugin.watchers?.[0]?.agent).toBe("prime-agent");
  });

  it("discovers V4 Flash through Prime's model command", async () => {
    const run = vi.fn(async () => [
      {
        stdout: `provider  model              context  max-out  thinking  images
opencode  deepseek-v4-flash  1M       384K     yes       no`,
        stderr: "",
        status: 0,
      },
    ]);
    const models = primeAgentPlugin.agents?.[0]?.models;

    expect(typeof models).toBe("function");
    if (typeof models !== "function") return;

    await expect(models({ sdk: { exec: { run } } } as never)).resolves.toContainEqual(
      expect.objectContaining({
        id: "opencode/deepseek-v4-flash",
        name: "deepseek-v4-flash (opencode)",
      }),
    );
    // Prime Agent's CLI prints its model table to stderr whenever stdout is a
    // pipe (the host captures output that way), so the launcher must merge
    // stderr into stdout — `2>/dev/null` silently drops every model.
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.stringMatching(/prime-agent model list 2>&1 \|\| .*prime-agent model list 2>&1/),
        ],
      }),
    );
  });
});
