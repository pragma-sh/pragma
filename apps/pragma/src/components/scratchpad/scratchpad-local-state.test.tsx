import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AskQuestion } from "../../../../../packages/scratchpad/src/ui";
import { Input } from "../../../../../packages/scratchpad/src/primitives";

afterEach(() => {
  cleanup();
  delete globalThis.pragmaScratchpad;
});

it("restores built-in choice and text input values after a remount", () => {
  const values = new Map<string, unknown>();
  globalThis.pragmaScratchpad = {
    getLocalState: (key) => values.get(key),
    setLocalState: (key, value) => {
      values.set(key, value);
    },
    promptAgent: async () => "sent",
    requestAgentAttachment: async () => false,
    subscribeAgentProgress: () => () => {},
    getWhiteboardSnapshot: async () => null,
  };
  const content = (
    <>
      <AskQuestion question="Pick" options={[{ label: "One" }, { label: "Two" }]} />
      <Input aria-label="Note" />
    </>
  );
  const view = render(content);
  fireEvent.click(screen.getByLabelText("Two"));
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "draft" } });
  view.unmount();
  render(content);
  expect(screen.getByLabelText("Two")).toBeChecked();
  expect(screen.getByLabelText("Note")).toHaveValue("draft");
});

it("keeps repeated controls with the same text independent", () => {
  const values = new Map<string, unknown>();
  globalThis.pragmaScratchpad = {
    getLocalState: (key) => values.get(key),
    setLocalState: (key, value) => {
      values.set(key, value);
    },
    promptAgent: async () => "sent",
    requestAgentAttachment: async () => false,
    subscribeAgentProgress: () => () => {},
    getWhiteboardSnapshot: async () => null,
  };
  const content = (
    <>
      <AskQuestion question="Pick" options={[{ label: "One" }, { label: "Two" }]} />
      <AskQuestion question="Pick" options={[{ label: "One" }, { label: "Two" }]} />
    </>
  );
  const view = render(content);
  fireEvent.click(screen.getAllByLabelText("Two")[0]!);
  view.unmount();
  render(content);
  const [restoredFirst, restoredSecond] = screen.getAllByLabelText("Two");
  expect(restoredFirst).toBeChecked();
  expect(restoredSecond).not.toBeChecked();
});
