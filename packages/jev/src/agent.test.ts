import { describe, expect, it } from "vitest";

import { describeDecision, toDecision } from "./agent.ts";
import type { Snapshot } from "./page.ts";

const snap: Snapshot = {
  title: "pragma",
  url: "http://localhost:1420/",
  viewport: [1024, 768],
  windowFocused: true,
  focused: "nothing",
  dialogs: [],
  elements: [{ index: 0, kind: "element", tag: "button", label: "Settings", box: [0, 0, 10, 10] }],
  terminals: [
    {
      index: 1,
      kind: "terminal",
      tabId: "t",
      visible: true,
      focused: false,
      cols: 80,
      rows: 24,
      cursor: [0, 0],
      lines: [],
    },
  ],
  texts: [],
};

describe("toDecision", () => {
  it("normalises a model answer", () => {
    expect(
      toDecision({
        thought: "go",
        action: "scroll",
        index: 2.4,
        text: null,
        keys: null,
        direction: "sideways",
        amount: 3,
        enter: "yes",
      }),
    ).toEqual({
      thought: "go",
      action: "scroll",
      index: 2,
      text: null,
      keys: null,
      direction: null,
      amount: 3,
      enter: null,
    });
  });

  it("rejects an unknown action", () => {
    expect(() => toDecision({ action: "teleport" })).toThrow(/unknown action/);
  });
});

describe("describeDecision", () => {
  const base = toDecision({ action: "click", thought: "" });

  it("names the element or terminal an index points at", () => {
    expect(describeDecision({ ...base, index: 0 }, snap)).toBe('click [0] button "Settings"');
    expect(
      describeDecision({ ...base, action: "type", index: 1, text: "ls", enter: true }, snap),
    ).toBe('type [1] terminal "ls" + Enter');
  });

  it("summarises non-target actions", () => {
    expect(describeDecision({ ...base, action: "key", keys: "Meta+t" }, null)).toBe("key Meta+t");
    expect(describeDecision({ ...base, action: "wait", amount: 500 }, null)).toBe("wait 500ms");
  });
});
