import { describe, expect, it } from "vitest";

import {
  actionForEvent,
  chordForPlatform,
  chordMatches,
  defaultKeybindingsConfig,
  tabIndexForAction,
  worktreeIndexForAction,
  workspaceIndexForAction,
} from "./keybindings";

import type { KeybindingChord, KeybindingsConfig } from "@pragma/constants";

function config(): KeybindingsConfig {
  return {
    version: 1,
    bindings: {
      ...defaultKeybindingsConfig.bindings,
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
      newBrowserTab: {
        mac: { modifiers: ["cmd"], key: "b" },
        linux: { modifiers: ["ctrl"], key: "b" },
      },
      clearTerminal: {
        mac: { modifiers: ["cmd"], key: "k" },
        linux: { modifiers: ["ctrl"], key: "k" },
      },
      browserReload: {
        mac: { modifiers: ["cmd"], key: "r" },
        linux: { modifiers: ["ctrl"], key: "r" },
      },
      browserDevtools: {
        mac: { modifiers: ["cmd", "shift"], key: "i" },
        linux: { modifiers: ["ctrl", "shift"], key: "i" },
      },
      browserCopyUrl: {
        mac: { modifiers: ["cmd", "shift"], key: "c" },
        linux: { modifiers: ["ctrl", "shift"], key: "c" },
      },
      splitHorizontal: {
        mac: { modifiers: ["cmd"], key: "/" },
        linux: { modifiers: ["ctrl"], key: "/" },
      },
      splitVertical: {
        mac: { modifiers: ["cmd", "shift"], key: "/" },
        linux: { modifiers: ["ctrl", "shift"], key: "/" },
      },
      deleteFile: {
        mac: { modifiers: ["cmd"], key: "backspace" },
        linux: { modifiers: ["ctrl"], key: "delete" },
      },
      scrollTerminalBottom: {
        mac: { modifiers: ["cmd"], key: "end" },
        linux: { modifiers: ["ctrl"], key: "end" },
      },
      openCommandPalette: {
        mac: { modifiers: ["cmd"], key: "p" },
        linux: { modifiers: ["ctrl"], key: "p" },
      },
      openCommandMode: {
        mac: { modifiers: ["cmd", "shift"], key: "p" },
        linux: { modifiers: ["ctrl", "shift"], key: "p" },
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

  it("matches a shifted slash chord when the key is '?", () => {
    const chord: KeybindingChord = { modifiers: ["cmd", "shift"], key: "/" };
    expect(
      chordMatches(
        new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, key: "?" }),
        chord,
      ),
    ).toBe(true);
  });

  it("matches a physical digit when macOS modifiers transform event.key", () => {
    const chord: KeybindingChord = { modifiers: ["alt", "shift"], key: "2" };
    expect(
      chordMatches(
        new KeyboardEvent("keydown", {
          altKey: true,
          shiftKey: true,
          key: "€",
          code: "Digit2",
        }),
        chord,
      ),
    ).toBe(true);
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

  it("resolves mac clear terminal", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "k" });
    expect(actionForEvent(event, config(), "mac")).toBe("clearTerminal");
  });

  it("resolves mac new browser tab", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "b" });
    expect(actionForEvent(event, config(), "mac")).toBe("newBrowserTab");
  });

  it("resolves mac browser devtools", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, key: "i" });
    expect(actionForEvent(event, config(), "mac")).toBe("browserDevtools");
  });

  it("resolves mac workspace switch", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "3" });
    expect(actionForEvent(event, config(), "mac")).toBe("switchToWorkspace3");
  });

  it("resolves mac split horizontal", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "/" });
    expect(actionForEvent(event, config(), "mac")).toBe("splitHorizontal");
  });

  it("resolves mac split vertical from the shifted slash key", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, key: "?" });
    expect(actionForEvent(event, config(), "mac")).toBe("splitVertical");
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

describe("number navigation actions", () => {
  it("extracts worktree and tab indices", () => {
    expect(worktreeIndexForAction("switchToWorktree1")).toBe(1);
    expect(worktreeIndexForAction("switchToWorktree9")).toBe(9);
    expect(worktreeIndexForAction("nextTab")).toBeNull();
    expect(tabIndexForAction("switchToTab1")).toBe(1);
    expect(tabIndexForAction("switchToTab9")).toBe(9);
    expect(tabIndexForAction("nextTab")).toBeNull();
  });
});
