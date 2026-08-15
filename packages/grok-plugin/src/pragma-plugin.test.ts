import { describe, expect, it } from "vitest";

import grokAgentPlugin, { parseGrokModels } from "./pragma-plugin";

/** The `initialize` result grok 0.2.114 returns, trimmed to the fields read here. */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  _meta: {
    modelState: {
      currentModelId: "grok-4.5",
      availableModels: [
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          description: "SpaceXAI's new frontier model",
          _meta: {
            totalContextTokens: 500_000,
            supportsReasoningEffort: true,
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "medium", value: "medium", label: "Medium Effort", default: false },
              { id: "low", value: "low", label: "Low Effort", default: false },
            ],
          },
        },
      ],
    },
  },
};

describe("parseGrokModels", () => {
  it("maps the ACP model catalog with its reasoning efforts", () => {
    expect(parseGrokModels(INITIALIZE_RESULT)).toEqual([
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        reasoning: [
          { id: "high", name: "High Effort" },
          { id: "medium", name: "Medium Effort" },
          { id: "low", name: "Low Effort" },
        ],
      },
    ]);
  });

  it("omits reasoning for a model that does not support it", () => {
    expect(
      parseGrokModels({
        _meta: {
          modelState: {
            availableModels: [
              {
                modelId: "grok-mini",
                name: "Grok Mini",
                _meta: { supportsReasoningEffort: false },
              },
            ],
          },
        },
      }),
    ).toEqual([{ id: "grok-mini", name: "Grok Mini" }]);
  });

  it("returns nothing for a malformed or empty catalog", () => {
    expect(parseGrokModels(undefined)).toEqual([]);
    expect(parseGrokModels({ _meta: {} })).toEqual([]);
    expect(parseGrokModels({ _meta: { modelState: { availableModels: [{}, 7] } } })).toEqual([]);
  });
});

describe("grokAgentPlugin", () => {
  const agent = grokAgentPlugin.agents?.[0];

  it("launches the plain `grok` command", () => {
    expect(agent?.id).toBe("grok");
    expect(agent?.launch.command).toEqual(["grok"]);
  });

  it("declares only the capabilities grok's hook surface cannot serve", () => {
    expect(agent?.excludeFeatures).toEqual(["commandApproval"]);
  });

  it("maps each permission mode to a real grok launch flag", () => {
    expect(agent?.args.permissionMode("default")).toEqual([]);
    expect(agent?.args.permissionMode("no-plan")).toEqual(["--no-plan"]);
    expect(agent?.args.permissionMode("always-approve")).toEqual(["--always-approve"]);
    expect(agent?.args.model("grok-4.5")).toEqual(["--model", "grok-4.5"]);
    expect(agent?.args.reasoning("high")).toEqual(["--reasoning-effort", "high"]);
  });

  it("registers the usage provider against the launcher's icon", () => {
    const provider = grokAgentPlugin.usageLimits?.[0];
    expect(provider?.id).toBe("grok");
    expect(provider?.primaryLimitId).toBe("credits");
    expect(provider?.iconPath).toBe(agent?.iconPath);
  });

  it("uses the local agent id for the watcher, so reports and events line up", () => {
    expect(grokAgentPlugin.watchers?.[0]?.agent).toBe("grok");
  });
});
