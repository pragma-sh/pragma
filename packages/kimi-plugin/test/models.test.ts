import { describe, expect, it, vi } from "vitest";

import {
  kimiModelsFromConfig,
  loadKimiModels,
  parseKimiDefaultModel,
  parseKimiProviderModels,
} from "../src/models";

const WITH_MODELS = JSON.stringify({
  providers: {
    opencode: { type: "openai", apiKey: "must-not-be-retained" },
  },
  models: {
    "opencode/gpt-5.5-pro": {
      provider: "opencode",
      model: "gpt-5.5-pro",
      displayName: "GPT 5.5 Pro (Opencode)",
      maxContextSize: 1_000_000,
    },
    "opencode/claude-sonnet-4-6": {
      provider: "opencode",
      model: "claude-sonnet-4-6",
    },
    "opencode/glm-5": {
      provider: "opencode",
      model: "glm-5",
    },
    "opencode/big-pickle": {
      provider: "opencode",
      model: "big-pickle",
      disabled: true,
    },
  },
});

describe("parseKimiProviderModels", () => {
  it("parses model aliases without retaining provider credentials or unrelated fields", () => {
    expect(parseKimiProviderModels(WITH_MODELS)).toEqual({
      "opencode/gpt-5.5-pro": {
        provider: "opencode",
        model: "gpt-5.5-pro",
        displayName: "GPT 5.5 Pro (Opencode)",
      },
      "opencode/claude-sonnet-4-6": { provider: "opencode", model: "claude-sonnet-4-6" },
      "opencode/glm-5": { provider: "opencode", model: "glm-5" },
    });
  });

  it("drops aliases Kimi reports as disabled", () => {
    expect(parseKimiProviderModels(WITH_MODELS)["opencode/big-pickle"]).toBeUndefined();
  });

  it("drops invalid aliases and malformed output", () => {
    expect(
      parseKimiProviderModels(
        JSON.stringify({ models: { broken: { provider: "opencode" }, good: { model: "good-1" } } }),
      ),
    ).toEqual({ good: { provider: "", model: "good-1" } });
    expect(parseKimiProviderModels("not json")).toEqual({});
    expect(parseKimiProviderModels("[]")).toEqual({});
  });
});

describe("kimiModelsFromConfig", () => {
  it("prefers displayName and preserves config declaration order", () => {
    expect(kimiModelsFromConfig(parseKimiProviderModels(WITH_MODELS))).toEqual([
      { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro (Opencode)" },
      { id: "opencode/claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      { id: "opencode/glm-5", name: "glm-5" },
    ]);
  });

  it("moves Kimi's configured default model to the front", () => {
    expect(kimiModelsFromConfig(parseKimiProviderModels(WITH_MODELS), "opencode/glm-5")).toEqual([
      { id: "opencode/glm-5", name: "glm-5" },
      { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro (Opencode)" },
      { id: "opencode/claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ]);
  });

  it("never fronts a disabled default alias", () => {
    expect(
      kimiModelsFromConfig(parseKimiProviderModels(WITH_MODELS), "opencode/big-pickle"),
    ).toEqual([
      { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro (Opencode)" },
      { id: "opencode/claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      { id: "opencode/glm-5", name: "glm-5" },
    ]);
  });
});

describe("parseKimiDefaultModel", () => {
  it("reads the optional alias from provider list output", () => {
    expect(
      parseKimiDefaultModel("opencode  type=openai  models=3\n\nDefault model: opencode/glm-5\n"),
    ).toBe("opencode/glm-5");
    expect(parseKimiDefaultModel("opencode  type=openai  models=3\n")).toBeUndefined();
  });
});

describe("loadKimiModels", () => {
  it("queries Kimi through the host SDK so the desktop bundle stays browser-safe", async () => {
    const run = vi
      .fn()
      .mockResolvedValue([
        { stdout: WITH_MODELS },
        { stdout: "opencode  type=openai  models=3\n\nDefault model: opencode/glm-5\n" },
      ]);

    await expect(
      loadKimiModels({
        project: { id: "project", name: "Project", path: "/project" },
        sdk: { exec: { run } },
      } as never),
    ).resolves.toEqual([
      { id: "opencode/glm-5", name: "glm-5" },
      { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro (Opencode)" },
      { id: "opencode/claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ]);
    expect(run).toHaveBeenCalledWith({
      cwd: "/project",
      commands: ["kimi provider list --json", "kimi provider list"],
    });
  });

  it("returns no models when the host command fails", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      loadKimiModels({ sdk: { exec: { run } }, project: null } as never),
    ).resolves.toEqual([]);
  });
});
