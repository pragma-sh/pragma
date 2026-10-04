import { describe, expect, it } from "vitest";

import { parseKeyCombo, parseKeySequence } from "./keys.ts";

describe("parseKeyCombo", () => {
  it("gives Enter the legacy keyCode xterm reads", () => {
    expect(parseKeyCombo("Enter")).toMatchObject({ key: "Enter", code: "Enter", keyCode: 13 });
  });

  it("parses modifier aliases case-insensitively", () => {
    expect(parseKeyCombo("cmd+Shift+p")).toMatchObject({
      key: "P",
      code: "KeyP",
      keyCode: 80,
      metaKey: true,
      shiftKey: true,
      ctrlKey: false,
    });
    expect(parseKeyCombo("Control+c")).toMatchObject({ key: "c", keyCode: 67, ctrlKey: true });
  });

  it("handles punctuation, digits, function keys, and a literal plus", () => {
    expect(parseKeyCombo("Meta+,")).toMatchObject({ key: ",", code: "Comma", metaKey: true });
    expect(parseKeyCombo("Meta+1")).toMatchObject({ code: "Digit1", keyCode: 49 });
    expect(parseKeyCombo("F5")).toMatchObject({ key: "F5", keyCode: 116 });
    expect(parseKeyCombo("Meta++")).toMatchObject({ key: "+", metaKey: true });
  });

  it("rejects unknown keys and modifiers", () => {
    expect(() => parseKeyCombo("Hyper+k")).toThrow(/modifier/);
    expect(() => parseKeyCombo("Banana")).toThrow(/unknown key/);
    expect(() => parseKeyCombo(" ")).toThrow(/empty/);
  });
});

describe("parseKeySequence", () => {
  it("splits on whitespace", () => {
    expect(parseKeySequence("Escape  Meta+k").map((stroke) => stroke.key)).toEqual(["Escape", "k"]);
  });
});
