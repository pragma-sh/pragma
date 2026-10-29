import type { PluginContext } from "@pragma-sh/plugin/catalog";
import { describe, expect, it } from "vitest";

import grokAgentPlugin, { grokResume, parseGrokModels } from "./pragma-plugin";

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
    expect(agent?.args.permissionMode("plan")).toEqual(["--permission-mode", "plan"]);
    expect(agent?.args.permissionMode("bypassPermissions")).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(agent?.args.model("grok-4.5")).toEqual(["--model", "grok-4.5"]);
    expect(agent?.args.reasoning("high")).toEqual(["--reasoning-effort", "high"]);
  });

  it("registers the xAI account provider against the launcher's icon", () => {
    const provider = grokAgentPlugin.accounts?.[0];
    expect(provider?.provider).toBe("xai");
    expect(provider?.usageLimits?.primaryLimitId).toBe("credits");
    expect(provider?.iconPath).toBe(agent?.iconPath);
    expect(provider?.env?.("/h/1")).toEqual({ GROK_HOME: "/h/1" });
  });

  it("uses the local agent id for the watcher, so reports and events line up", () => {
    expect(grokAgentPlugin.watchers?.[0]?.agent).toBe("grok");
  });

  it("wires the resume callback into the launch contract", () => {
    expect(agent?.launch.resume).toBe(grokResume);
  });
});

describe("grokResume", () => {
  const ctx = {} as unknown as PluginContext;

  it("builds the full literal argv with the stored selection's flags", () => {
    expect(
      grokResume(
        {
          harnessSessionId: "01a1175c-db4b-7153-8db2-6de48cb8f730",
          selection: { modelId: "grok-4.5", reasoningId: "high", permissionModeId: "plan" },
          cwd: "/repo",
        },
        ctx,
      ),
    ).toEqual([
      "grok",
      "--model",
      "grok-4.5",
      "--reasoning-effort",
      "high",
      "--permission-mode",
      "plan",
      "--resume",
      "01a1175c-db4b-7153-8db2-6de48cb8f730",
    ]);
  });

  it("resumes bare when no selection was stored", () => {
    expect(grokResume({ harnessSessionId: "abc", selection: {}, cwd: "/repo" }, ctx)).toEqual([
      "grok",
      "--resume",
      "abc",
    ]);
  });
});
