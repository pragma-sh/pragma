import { describe, expect, it, vi } from "vitest";

import { ompAgentPlugin, parseOmpModels } from "./pragma-plugin";

describe("omp Pragma plugin", () => {
  it("launches omp with a matching watcher identity and resume", () => {
    const agent = ompAgentPlugin.agents?.[0];
    expect(agent).toMatchObject({ id: "omp", name: "Oh My Pi", launch: { command: ["omp"] } });
    expect(ompAgentPlugin.watchers?.[0]?.agent).toBe("omp");
    expect(
      agent?.launch.resume?.(
        {
          harnessSessionId: "01a1c72c",
          selection: { modelId: "openai-codex/gpt-5.6-luna", reasoningId: "low" },
          cwd: "/repo",
        } as never,
        {} as never,
      ),
    ).toEqual([
      "omp",
      "--resume",
      "01a1c72c",
      "--model",
      "openai-codex/gpt-5.6-luna",
      "--thinking",
      "low",
    ]);
  });

  it("declares only the capabilities omp lacks out of the box", () => {
    expect(ompAgentPlugin.agents?.[0]?.excludeFeatures).toEqual(["commandApproval", "usageLimits"]);
  });

  it("parses omp's JSON model catalog into selectors with per-model thinking", () => {
    const output = `update available\n${JSON.stringify({
      models: [
        {
          provider: "openai-codex",
          kind: "chat",
          id: "gpt-5.6-luna",
          selector: "openai-codex/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          reasoning: true,
          thinking: ["low", "xhigh"],
        },
        {
          provider: "ollama",
          kind: "chat",
          id: "qwen3",
          name: "",
          reasoning: false,
          thinking: null,
        },
        { provider: "x", kind: "embedding", id: "e", selector: "x/e" },
      ],
    })}`;
    expect(parseOmpModels(output)).toEqual([
      {
        id: "openai-codex/gpt-5.6-luna",
        name: "GPT-5.6 Luna (openai-codex)",
        reasoning: [
          { id: "low", name: "Low" },
          { id: "xhigh", name: "Extra High" },
        ],
      },
      { id: "ollama/qwen3", name: "qwen3 (ollama)" },
    ]);
    expect(parseOmpModels("not json")).toEqual([]);
  });

  it("lists models through omp's JSON catalog command", async () => {
    const run = vi.fn(async () => [
      { stdout: JSON.stringify({ models: [{ provider: "p", id: "m" }] }), stderr: "", status: 0 },
    ]);
    const models = ompAgentPlugin.agents?.[0]?.models;
    expect(typeof models).toBe("function");
    if (typeof models !== "function") return;
    await expect(models({ sdk: { exec: { run } } } as never)).resolves.toEqual([
      { id: "p/m", name: "m (p)" },
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ commands: [expect.stringMatching(/^omp models --json/)] }),
    );
  });
});
