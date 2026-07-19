import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  browserOpenExternal: vi.fn(async () => {}),
}));

import { ChecksSummary } from "./ViewPullRequestView";
import { browserOpenExternal } from "@/lib/tauri";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChecksSummary", () => {
  it("shows aggregate state circles and expands each GitHub check", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "failure",
          total: 3,
          passed: 1,
          failed: 1,
          pending: 1,
          items: [
            { name: "build", state: "success", url: null },
            { name: "lint", state: "failure", url: null },
            { name: "test", state: "pending", url: null },
          ],
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: /1 of 3 checks failed/i });
    expect(trigger).toHaveTextContent("1 of 3 checks failed");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(await screen.findByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("opens a check's external URL when selecting its status", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "success",
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          items: [{ name: "Greptile review", state: "success", url: "https://app.greptile.com" }],
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /all 1 checks passed/i }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Greptile review"));

    expect(browserOpenExternal).toHaveBeenCalledWith("https://app.greptile.com");
  });

  it("does not open a URL for a check that has none", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "pending",
          total: 1,
          passed: 0,
          failed: 0,
          pending: 1,
          items: [{ name: "test", state: "pending", url: null }],
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /0\/1 checks complete/i }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("test"));

    expect(browserOpenExternal).not.toHaveBeenCalled();
  });
});
