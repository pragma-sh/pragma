import { describe, expect, it } from "vitest";

import { constants } from "./index";

describe("constants", () => {
  it("exposes a non-empty app name", () => {
    expect(constants.app.name).not.toBe("");
  });

  it("has sane default window dimensions", () => {
    expect(constants.window.defaultWidth).toBeGreaterThanOrEqual(constants.window.minWidth);
    expect(constants.window.defaultHeight).toBeGreaterThanOrEqual(constants.window.minHeight);
  });

  it("has a valid default editor launcher", () => {
    expect(constants.editorLaunchers.options.length).toBeGreaterThan(0);
    expect(
      constants.editorLaunchers.options.some(
        (editor) => editor.id === constants.editorLaunchers.defaultEditorId,
      ),
    ).toBe(true);
  });
});
