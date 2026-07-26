import { describe, expect, it } from "vitest";

import {
  chordFromKeyboardEvent,
  chordsEqual,
  formatChord,
  isDefaultChord,
  keybindingActionLabel,
  keybindingActions,
  parseKeybindingOverrides,
  serializeKeybindingOverrides,
  withChordOverride,
  withoutChordOverride,
} from "@/lib/keybinding-editing";
import { defaultKeybindingsConfig } from "@/lib/keybindings";

describe("keybinding editing", () => {
  it("labels every action in the default config", () => {
    const actions = Object.keys(defaultKeybindingsConfig.bindings).toSorted();
    expect(keybindingActions.toSorted()).toEqual(actions);
    for (const action of keybindingActions) {
      expect(keybindingActionLabel(action)).not.toBe(action);
    }
  });

  it("formats chords per platform", () => {
    expect(formatChord({ modifiers: ["cmd", "shift"], key: "p" }, "mac")).toBe("⇧⌘P");
    expect(formatChord({ modifiers: ["ctrl", "shift"], key: "p" }, "linux")).toBe("Ctrl+Shift+P");
    expect(formatChord({ modifiers: [], key: "space" }, "mac")).toBe("Space");
    expect(formatChord({ modifiers: ["cmd"], key: "backspace" }, "mac")).toBe("⌘⌫");
  });

  it("compares chords by key and modifier set, ignoring order", () => {
    expect(
      chordsEqual(
        { modifiers: ["cmd", "shift"], key: "k" },
        { modifiers: ["shift", "cmd"], key: "K" },
      ),
    ).toBe(true);
    expect(chordsEqual({ modifiers: ["cmd"], key: "k" }, { modifiers: [], key: "k" })).toBe(false);
  });

  it("builds a chord from a key press and ignores modifier-only presses", () => {
    const press = new KeyboardEvent("keydown", { key: "T", metaKey: true, shiftKey: true });
    expect(chordFromKeyboardEvent(press)).toEqual({ modifiers: ["cmd", "shift"], key: "t" });
    expect(chordFromKeyboardEvent(new KeyboardEvent("keydown", { key: "Shift" }))).toBeNull();
    expect(chordFromKeyboardEvent(new KeyboardEvent("keydown", { key: " " }))).toEqual({
      modifiers: [],
      key: "space",
    });
  });

  it("reports whether an effective chord still matches the default", () => {
    expect(isDefaultChord("newTerminalTab", "mac", defaultKeybindingsConfig)).toBe(true);
    const changed = {
      ...defaultKeybindingsConfig,
      bindings: {
        ...defaultKeybindingsConfig.bindings,
        newTerminalTab: {
          ...defaultKeybindingsConfig.bindings.newTerminalTab,
          mac: { modifiers: ["cmd" as const], key: "n" },
        },
      },
    };
    expect(isDefaultChord("newTerminalTab", "mac", changed)).toBe(false);
    // The other platform is untouched by a single-platform override.
    expect(isDefaultChord("newTerminalTab", "linux", changed)).toBe(true);
  });

  it("patches one platform of one action and leaves the rest alone", () => {
    const overrides = withChordOverride({}, "clearTerminal", "mac", {
      modifiers: ["cmd", "shift"],
      key: "k",
    });
    expect(overrides.bindings?.clearTerminal?.mac).toEqual({
      modifiers: ["cmd", "shift"],
      key: "k",
    });
    expect(overrides.bindings?.clearTerminal?.linux).toBeUndefined();
    expect(overrides.version).toBe(defaultKeybindingsConfig.version);
  });

  it("removes an override and prunes the emptied objects", () => {
    const withOverride = withChordOverride({}, "clearTerminal", "mac", {
      modifiers: ["cmd"],
      key: "l",
    });
    const removed = withoutChordOverride(withOverride, "clearTerminal", "mac");
    expect(removed.bindings).toBeUndefined();
  });

  it("keeps unrelated keys in a hand-edited file", () => {
    const contents = serializeKeybindingOverrides(
      withChordOverride(parseKeybindingOverrides('{ "note": "mine" }'), "nextTab", "linux", {
        modifiers: ["alt"],
        key: "j",
      }),
    );
    expect(JSON.parse(contents)).toMatchObject({
      note: "mine",
      bindings: { nextTab: { linux: { key: "j" } } },
    });
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("treats a blank file as no overrides and rejects non-objects", () => {
    expect(parseKeybindingOverrides("   ")).toEqual({});
    expect(() => parseKeybindingOverrides("[]")).toThrow();
  });
});
