import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RenameEntryInput } from "./RenameEntryInput";

afterEach(cleanup);

function setup(options: { initialName: string; kind?: "file" | "folder"; siblings?: string[] }) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <RenameEntryInput
      depth={0}
      initialName={options.initialName}
      kind={options.kind ?? "file"}
      onCancel={onCancel}
      onCommit={onCommit}
      siblings={options.siblings ?? []}
    />,
  );
  const input = screen.getByLabelText(
    options.kind === "folder" ? "Rename folder" : "Rename file",
  ) as HTMLInputElement;
  return { input, onCommit, onCancel };
}

describe("RenameEntryInput", () => {
  it("pre-fills the current name", () => {
    const { input } = setup({ initialName: "app.ts" });
    expect(input.value).toBe("app.ts");
  });

  it("commits a new name on Enter", () => {
    const { input, onCommit } = setup({ initialName: "app.ts" });
    fireEvent.change(input, { target: { value: "main.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("main.ts");
  });

  it("cancels on Escape without committing", () => {
    const { input, onCommit, onCancel } = setup({ initialName: "app.ts" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("allows keeping the same name (a no-op rename is still a valid commit)", () => {
    const { input, onCommit } = setup({ initialName: "app.ts", siblings: ["app.ts"] });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("app.ts");
  });

  it("rejects a duplicate sibling name with a red border and no commit", () => {
    const { input, onCommit } = setup({ initialName: "app.ts", siblings: ["app.ts", "other.ts"] });
    fireEvent.change(input, { target: { value: "other.ts" } });
    expect(input.className).toContain("border-destructive/70");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects an empty name", () => {
    const { input, onCommit } = setup({ initialName: "app.ts" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
