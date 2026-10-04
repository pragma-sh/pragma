import { describe, expect, it } from "vitest";

import { parseKeyCombo } from "./keys.ts";
import { acceleratorStroke, menuItemFor } from "./menu.ts";

const items = [
  { id: "tabs.new-terminal", accelerator: "CmdOrCtrl+T" },
  { id: "workspace.open-command-mode", accelerator: "CmdOrCtrl+Shift+P" },
  { id: "workspace.open-command-palette", accelerator: "CmdOrCtrl+P" },
];

describe("acceleratorStroke", () => {
  it("maps CmdOrCtrl to the platform's primary modifier", () => {
    expect(acceleratorStroke("CmdOrCtrl+T", "darwin")).toMatchObject({
      metaKey: true,
      ctrlKey: false,
    });
    expect(acceleratorStroke("CmdOrCtrl+T", "linux")).toMatchObject({
      metaKey: false,
      ctrlKey: true,
    });
  });
});

describe("menuItemFor", () => {
  it("matches on key and the exact modifier set", () => {
    expect(menuItemFor(parseKeyCombo("Meta+t"), items, "darwin")?.id).toBe("tabs.new-terminal");
    expect(menuItemFor(parseKeyCombo("Meta+Shift+p"), items, "darwin")?.id).toBe(
      "workspace.open-command-mode",
    );
    expect(menuItemFor(parseKeyCombo("Meta+p"), items, "darwin")?.id).toBe(
      "workspace.open-command-palette",
    );
  });

  it("leaves other chords to the page", () => {
    expect(menuItemFor(parseKeyCombo("Control+t"), items, "darwin")).toBeNull();
    expect(menuItemFor(parseKeyCombo("Enter"), items, "darwin")).toBeNull();
  });
});
