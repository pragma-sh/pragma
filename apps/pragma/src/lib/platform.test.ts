import { describe, expect, it } from "vitest";

import { hasWorkspaceModifier, workspaceModifier, workspaceModifierLabel } from "./platform";

describe("platform shortcuts", () => {
  it("uses Ctrl on macOS", () => {
    expect(workspaceModifier("MacIntel")).toBe("ctrl");
    expect(workspaceModifierLabel("MacIntel")).toBe("Ctrl");
  });

  it("uses Alt elsewhere", () => {
    expect(workspaceModifier("Linux x86_64")).toBe("alt");
    expect(workspaceModifierLabel("Linux x86_64")).toBe("Alt");
  });

  it("checks the active modifier", () => {
    const event = new KeyboardEvent("keydown", { altKey: true });
    expect(hasWorkspaceModifier(event, "Linux x86_64")).toBe(true);
    expect(hasWorkspaceModifier(event, "MacIntel")).toBe(false);
  });
});
