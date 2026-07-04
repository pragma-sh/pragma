import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createBridge, setBridge } from "./test/bridge";
import { FORTUNES } from "./fortunes";
import plugin from "./index";
import { FORTUNE_REROLL_EVENT, FortuneTab } from "./fortune-tab";

describe("FortuneTab", () => {
  it("renders the persisted (first) fortune and a project placeholder", () => {
    render(<FortuneTab />);

    expect(screen.getByTestId("fortune")).toHaveTextContent(FORTUNES[0]!);
    expect(screen.getByText("Project: None")).toBeInTheDocument();
  });

  it("rerolls a deterministic new fortune and notifies", () => {
    const notify = vi.fn();
    setBridge(
      createBridge({
        useNotify: () => notify,
        useProject: () => ({ id: "demo", name: "Demo", path: "/demo" }),
      }),
    );
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    render(<FortuneTab />);
    fireEvent.click(screen.getByText("Reroll"));

    const expected = FORTUNES[Math.floor(0.5 * FORTUNES.length)]!;
    expect(screen.getByTestId("fortune")).toHaveTextContent(expected);
    expect(notify).toHaveBeenCalledWith("New fortune!", { variant: "info" });

    randomSpy.mockRestore();
  });

  it("rerolls from the fortune shortcut event", () => {
    const notify = vi.fn();
    setBridge(createBridge({ useNotify: () => notify }));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.25);

    render(<FortuneTab />);
    fireEvent(window, new Event(FORTUNE_REROLL_EVENT));

    const expected = FORTUNES[Math.floor(0.25 * FORTUNES.length)]!;
    expect(screen.getByTestId("fortune")).toHaveTextContent(expected);
    expect(notify).toHaveBeenCalledWith("New fortune!", { variant: "info" });

    randomSpy.mockRestore();
  });

  it("binds mod+k to the fortune reroll command", () => {
    const command = plugin.commands?.find(
      (entry) => entry.id === "pragma-dev-test-plugin.fortune.reroll",
    );

    expect(command?.defaultBinding).toBe("mod+k");
  });

  it("dispatches the fortune reroll event from the plugin command", () => {
    const command = plugin.commands?.find(
      (entry) => entry.id === "pragma-dev-test-plugin.fortune.reroll",
    );
    const listener = vi.fn();
    expect(command).toBeDefined();
    window.addEventListener(FORTUNE_REROLL_EVENT, listener);

    command?.run({} as never);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(FORTUNE_REROLL_EVENT, listener);
  });
});
