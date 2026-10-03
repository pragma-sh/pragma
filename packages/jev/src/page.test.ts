import { describe, expect, it } from "vitest";

import { renderSnapshot } from "./page.ts";

describe("renderSnapshot", () => {
  it("renders elements with state, and terminals with their canvas text", () => {
    const text = renderSnapshot({
      title: "pragma",
      url: "",
      viewport: [800, 600],
      windowFocused: false,
      focused: "the terminal (typing goes to the shell)",
      dialogs: ["Settings"],
      elements: [
        {
          index: 0,
          kind: "element",
          tag: "button",
          label: "Theme",
          expanded: "false",
          covered: true,
          box: [1, 2, 3, 4],
        },
        {
          index: 1,
          kind: "element",
          tag: "input",
          type: "text",
          label: "Search",
          editable: true,
          value: "abc",
          box: [0, 0, 1, 1],
        },
      ],
      terminals: [
        {
          index: 2,
          kind: "terminal",
          tabId: "tab",
          visible: true,
          focused: true,
          cols: 80,
          rows: 24,
          cursor: [0, 0],
          lines: ["$ ls", "a b"],
        },
      ],
      texts: ["Hello"],
    });
    expect(text).toContain("(window not focused)");
    expect(text).toContain('open dialogs: "Settings"');
    expect(text).toContain('[0] button "Theme" expanded=false covered @1,2 3x4');
    expect(text).toContain('[1] input[text] "Search" value="abc"');
    expect(text).toContain("[2] TERMINAL (canvas) tab=tab 80x24 focused");
    expect(text).toContain("    │ $ ls");
    expect(text).toContain("  Hello");
  });
});
