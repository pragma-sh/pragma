import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewEntryInput } from "./NewEntryInput";

afterEach(cleanup);

function setup(siblings: string[] = []) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <NewEntryInput
      depth={0}
      kind="file"
      onCancel={onCancel}
      onCommit={onCommit}
      siblings={siblings}
    />,
  );
  const input = screen.getByLabelText("New file name");
  return { input, onCommit, onCancel };
}

describe("NewEntryInput", () => {
  it("commits a valid name on Enter", () => {
    const { input, onCommit } = setup(["existing.ts"]);
    fireEvent.change(input, { target: { value: "app.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("app.ts");
  });

  it("cancels on Escape without committing", () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: "app.ts" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps a red border and does not commit a duplicate name", () => {
    const { input, onCommit } = setup(["app.ts"]);
    fireEvent.change(input, { target: { value: "APP.TS" } });
    expect(input.className).toContain("border-destructive/70");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit an empty name", () => {
    const { input, onCommit } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
