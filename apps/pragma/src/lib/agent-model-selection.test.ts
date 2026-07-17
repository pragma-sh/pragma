import { describe, expect, it } from "vitest";

import type { AgentConfig, AgentModel } from "@/lib/tauri";

import { modelLaunchArgs, resolveDeepLinkAgentSelection } from "./agent-model-selection";

const agents: AgentConfig[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    iconDataUrl: null,
    start: ["claude"],
    models: { source: "static", modelArg: ["--model", "{model}"], items: [] },
  },
  {
    id: "cursor",
    name: "Cursor",
    iconDataUrl: null,
    start: ["agent"],
    models: {
      source: "command",
      command: ["sh", "scripts/list-models.sh"],
      modelArg: ["--model", "{model}"],
      reasoningArg: ["--effort", "{reasoning}"],
      modelReasoningArg: ["--model", "{model}[effort={reasoning}]"],
    },
  },
];

const cursorModels: AgentModel[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    reasoning: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ],
  },
  { id: "gpt-5.5.fast", name: "GPT-5.5 Fast", reasoning: [] },
];

describe("modelLaunchArgs", () => {
  it("returns no args with no model selected", () => {
    expect(modelLaunchArgs(agents[1]!, { modelId: null, reasoningId: null })).toEqual([]);
  });

  it("uses modelArg when only a model is selected", () => {
    expect(modelLaunchArgs(agents[1]!, { modelId: "gpt-5.5", reasoningId: null })).toEqual([
      "--model",
      "gpt-5.5",
    ]);
  });

  it("prefers modelReasoningArg when model and reasoning are selected", () => {
    expect(modelLaunchArgs(agents[1]!, { modelId: "gpt-5.5", reasoningId: "high" })).toEqual([
      "--model",
      "gpt-5.5[effort=high]",
    ]);
  });

  it("falls back to modelArg plus reasoningArg", () => {
    const agent = {
      ...agents[1]!,
      models: {
        source: "command" as const,
        command: ["x"],
        modelArg: ["-m", "{model}"],
        reasoningArg: ["-r", "{reasoning}"],
      },
    };
    expect(modelLaunchArgs(agent, { modelId: "gpt-5.5", reasoningId: "low" })).toEqual([
      "-m",
      "gpt-5.5",
      "-r",
      "low",
    ]);
  });

  it("splits a raw modelCmd and ignores catalog args", () => {
    expect(
      modelLaunchArgs(agents[1]!, {
        modelId: "gpt-5.5",
        reasoningId: "high",
        modelCmd: "--model moonshot/kimi-k3",
      }),
    ).toEqual(["--model", "moonshot/kimi-k3"]);
  });

  it("treats a blank modelCmd as absent", () => {
    expect(
      modelLaunchArgs(agents[1]!, { modelId: "gpt-5.5", reasoningId: null, modelCmd: "  " }),
    ).toEqual(["--model", "gpt-5.5"]);
  });
});

describe("resolveDeepLinkAgentSelection", () => {
  it("resolves explicit params", () => {
    expect(
      resolveDeepLinkAgentSelection(
        { agentId: "cursor", modelId: "gpt-5.5", reasoningId: "low" },
        agents,
        { cursor: cursorModels },
      ),
    ).toEqual({ agentId: "cursor", selection: { modelId: "gpt-5.5", reasoningId: "low" } });
  });

  it("resolves compact params while preserving dotted model ids", () => {
    expect(
      resolveDeepLinkAgentSelection({ agentId: "cursor.gpt-5.5.fast" }, agents, {
        cursor: cursorModels,
      }),
    ).toEqual({ agentId: "cursor", selection: { modelId: "gpt-5.5.fast", reasoningId: null } });
  });

  it("treats the final dotted suffix as reasoning only when valid", () => {
    expect(
      resolveDeepLinkAgentSelection({ agentId: "cursor.gpt-5.5.high" }, agents, {
        cursor: cursorModels,
      }),
    ).toEqual({ agentId: "cursor", selection: { modelId: "gpt-5.5", reasoningId: "high" } });
  });

  it("falls back to no model for invalid model or reasoning", () => {
    expect(
      resolveDeepLinkAgentSelection({ agentId: "cursor.gpt-5.5.turbo" }, agents, {
        cursor: cursorModels,
      }),
    ).toEqual({ agentId: "cursor", selection: { modelId: null, reasoningId: null } });
  });
});
