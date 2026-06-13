import { describe, expect, it } from "vitest";

import {
  actionForEvent,
  chordForPlatform,
  chordMatches,
  workspaceIndexForAction,
} from "./keybindings";

import type { KeybindingChord, KeybindingsConfig } from "@pragma/constants";

function config(): KeybindingsConfig {
  return {
    version: 1,
    bindings: {
      nextTab: {
        mac: { modifiers: ["ctrl"], key: "tab" },
        linux: { modifiers: ["alt"], key: "tab" },
      },
      previousTab: {
        mac: { modifiers: ["ctrl", "shift"], key: "tab" },
        linux: { modifiers: ["alt", "shift"], key: "tab" },
      },
      closeTopTab: {
        mac: { modifiers: ["cmd"], key: "w" },
        linux: { modifiers: ["ctrl"], key: "w" },
      },
      newTerminalTab: {
        mac: { modifiers: ["cmd"], key: "t" },
        linux: { modifiers: ["ctrl"], key: "t" },
      },
      switchToWorkspace1: {
        mac: { modifiers: ["ctrl"], key: "1" },
        linux: { modifiers: ["alt"], key: "1" },
      },
      switchToWorkspace2: {
        mac: { modifiers: ["ctrl"], key: "2" },
        linux: { modifiers: ["alt"], key: "2" },
      },
      switchToWorkspace3: {
        mac: { modifiers: ["ctrl"], key: "3" },
        linux: { modifiers: ["alt"], key: "3" },
      },
      switchToWorkspace4: {
        mac: { modifiers: ["ctrl"], key: "4" },
        linux: { modifiers: ["alt"], key: "4" },
      },
      switchToWorkspace5: {
        mac: { modifiers: ["ctrl"], key: "5" },
        linux: { modifiers: ["alt"], key: "5" },
      },
      switchToWorkspace6: {
        mac: { modifiers: ["ctrl"], key: "6" },
        linux: { modifiers: ["alt"], key: "6" },
      },
      switchToWorkspace7: {
        mac: { modifiers: ["ctrl"], key: "7" },
        linux: { modifiers: ["alt"], key: "7" },
      },
      switchToWorkspace8: {
        mac: { modifiers: ["ctrl"], key: "8" },
        linux: { modifiers: ["alt"], key: "8" },
      },
      switchToWorkspace9: {
        mac: { modifiers: ["ctrl"], key: "9" },
        linux: { modifiers: ["alt"], key: "9" },
      },
    },
  };
}

describe("chordMatches", () => {
  it("matches a simple chord", () => {
    const chord: KeybindingChord = { modifiers: ["ctrl"], key: "tab" };
    expect(chordMatches(new KeyboardEvent("keydown", { ctrlKey: true, key: "Tab" }), chord)).toBe(
      true,
    );
  });

  it("rejects a chord with extra modifiers", () => {
    const chord: KeybindingChord = { modifiers: ["ctrl"], key: "tab" };
    expect(
      chordMatches(
        new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "Tab" }),
        chord,
      ),
    ).toBe(false);
  });

  it("is case-insensitive for letter keys", () => {
    const chord: KeybindingChord = { modifiers: ["cmd"], key: "w" };
    expect(chordMatches(new KeyboardEvent("keydown", { metaKey: true, key: "w" }), chord)).toBe(
      true,
    );
    expect(chordMatches(new KeyboardEvent("keydown", { metaKey: true, key: "W" }), chord)).toBe(
      true,
    );
  });
});

describe("chordForPlatform", () => {
  it("selects the mac chord on mac", () => {
    const chord = chordForPlatform(config().bindings.nextTab, "mac");
    expect(chord.modifiers).toEqual(["ctrl"]);
    expect(chord.key).toBe("tab");
  });

  it("selects the linux chord on linux", () => {
    const chord = chordForPlatform(config().bindings.nextTab, "linux");
    expect(chord.modifiers).toEqual(["alt"]);
    expect(chord.key).toBe("tab");
  });
});

describe("actionForEvent", () => {
  it("resolves mac close top tab", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "w" });
    expect(actionForEvent(event, config(), "mac")).toBe("closeTopTab");
  });

  it("resolves linux new terminal tab", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "t" });
    expect(actionForEvent(event, config(), "linux")).toBe("newTerminalTab");
  });

  it("resolves mac workspace switch", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "3" });
    expect(actionForEvent(event, config(), "mac")).toBe("switchToWorkspace3");
  });

  it("returns null for an unmatched chord", () => {
    const event = new KeyboardEvent("keydown", { key: "a" });
    expect(actionForEvent(event, config(), "mac")).toBeNull();
  });
});

describe("workspaceIndexForAction", () => {
  it("extracts workspace indices", () => {
    expect(workspaceIndexForAction("switchToWorkspace1")).toBe(1);
    expect(workspaceIndexForAction("switchToWorkspace9")).toBe(9);
    expect(workspaceIndexForAction("nextTab")).toBeNull();
  });
});
