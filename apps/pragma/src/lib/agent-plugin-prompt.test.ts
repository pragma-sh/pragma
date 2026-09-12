import { describe, expect, it } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";
import type { LockedPlugin } from "@pragma/plugin-registry";

import type { PluginRecord } from "@/plugins/registry";

import { missingAgentPluginForCommand } from "./agent-plugin-prompt";

const officialPlugin = {
  package: "@pragma-sh/opencode-plugin",
  manifest: { agentBinary: "opencode" },
} as LockedPlugin;

function record(): PluginRecord {
  return {
    pluginId: "pragma.opencode",
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: {},
    definition: {
      agents: [{ launch: { command: ["opencode"] } }],
    } as PluginDefinition,
  };
}

describe("missingAgentPluginForCommand", () => {
  it("matches an official agent command when its plugin is not installed", () => {
    expect(missingAgentPluginForCommand("opencode --model test", [], [officialPlugin])).toBe(
      officialPlugin,
    );
  });

  it("matches an agent executable invoked through a path", () => {
    expect(missingAgentPluginForCommand("/opt/bin/opencode", [], [officialPlugin])).toBe(
      officialPlugin,
    );
  });

  it("does not prompt when an installed plugin provides the agent", () => {
    expect(missingAgentPluginForCommand("opencode", [record()], [officialPlugin])).toBeNull();
  });

  it("ignores unrelated commands", () => {
    expect(missingAgentPluginForCommand("git status", [], [officialPlugin])).toBeNull();
  });
});
