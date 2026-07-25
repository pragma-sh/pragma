import { describe, expect, it } from "vitest";

import { constants } from "@pragma/constants";

import { mergeAgentStatusSettings, validateAgentStatusSettings } from "@/lib/agent-status-settings";

describe("agent status settings", () => {
  it("falls back to the shipped defaults", () => {
    expect(mergeAgentStatusSettings({}, {})).toEqual({
      notificationsEnabled: constants.agentStatus.notificationsEnabled,
      soundName: null,
      soundScope: "global",
    });
  });

  it("lets a project override each field independently", () => {
    expect(
      mergeAgentStatusSettings(
        { notificationsEnabled: false, soundName: "global.wav" },
        { soundName: "project.wav" },
      ),
    ).toEqual({ notificationsEnabled: false, soundName: "project.wav", soundScope: "project" });
    expect(
      mergeAgentStatusSettings({ soundName: "global.wav" }, { notificationsEnabled: false }),
    ).toEqual({ notificationsEnabled: false, soundName: "global.wav", soundScope: "global" });
  });

  it("keeps an explicit project built-in chime over a global custom sound", () => {
    expect(mergeAgentStatusSettings({ soundName: "global.wav" }, { soundName: null })).toEqual({
      notificationsEnabled: constants.agentStatus.notificationsEnabled,
      soundName: null,
      soundScope: "global",
    });
  });

  it("accepts an absent block and a null sound", () => {
    expect(validateAgentStatusSettings(undefined)).toEqual({});
    expect(validateAgentStatusSettings({ soundName: null })).toEqual({ soundName: null });
  });

  it("rejects a malformed block so Settings can surface it", () => {
    expect(() => validateAgentStatusSettings([])).toThrow();
    expect(() => validateAgentStatusSettings({ notificationsEnabled: "yes" })).toThrow();
    expect(() => validateAgentStatusSettings({ soundName: 7 })).toThrow();
  });
});
