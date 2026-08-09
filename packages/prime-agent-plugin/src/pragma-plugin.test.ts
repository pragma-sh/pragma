import { describe, expect, it, vi } from "vitest";

import { primeAgentPlugin } from "./pragma-plugin";

describe("Prime Agent plugin", () => {
  it("launches Prime Agent with matching watcher identity", () => {
    expect(primeAgentPlugin.agents?.[0]).toMatchObject({
      id: "prime-agent",
      name: "Prime Agent",
      launch: { command: ["prime-agent"] },
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
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [expect.stringContaining("prime-agent model list")],
      }),
    );
  });
});
