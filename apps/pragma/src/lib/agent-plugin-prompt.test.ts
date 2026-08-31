import { describe, expect, it } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";
import type { LockedPlugin } from "@pragma/plugin-registry";

import type { PluginRecord } from "@/plugins/registry";

import { missingAgentPluginForCommand } from "./agent-plugin-prompt";

const officialPlugin = {
  package: "@pragma-sh/opencode-plugin",
  manifest: { agentBinary: "opencode" },
} as LockedPlugin;

function record(scope: PluginRecord["scope"]): PluginRecord {
  return {
    pluginId: "pragma.opencode",
    version: "1.0.0",
    scope,
    status: "loaded",
    config: {},
    definition: {
      agents: [{ launch: { command: ["opencode"] } }],
    } as PluginDefinition,
  };
}

describe("missingAgentPluginForCommand", () => {
  it("matches a submitted registered agent command when only bundled plugin is active", () => {
    expect(
      missingAgentPluginForCommand("opencode --model test", [record("bundled")], [officialPlugin]),
    ).toBe(officialPlugin);
  });

  it("matches an agent executable invoked through a path", () => {
    expect(
      missingAgentPluginForCommand("/opt/bin/opencode", [record("bundled")], [officialPlugin]),
    ).toBe(officialPlugin);
  });

  it("does not prompt when installed plugin overrides bundled plugin", () => {
    expect(
      missingAgentPluginForCommand("opencode", [record("global")], [officialPlugin]),
    ).toBeNull();
  });

  it("ignores unrelated commands", () => {
    expect(
      missingAgentPluginForCommand("git status", [record("bundled")], [officialPlugin]),
    ).toBeNull();
  });
});
