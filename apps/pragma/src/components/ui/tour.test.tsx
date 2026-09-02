import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tour, type TourStep } from "@/components/ui/tour";

const STEPS: TourStep[] = [
  { id: "one", target: "[data-tour='one']", title: "First", description: "First stop" },
  { id: "two", target: "[data-tour='two']", title: "Second", description: "Second stop" },
];

function renderTour(onFinish = vi.fn()) {
  render(
    <>
      <button data-tour="one" type="button">
        one
      </button>
      <button data-tour="two" type="button">
        two
      </button>
      <Tour onFinish={onFinish} open steps={STEPS} />
    </>,
  );
  return onFinish;
}

// jsdom reports a zero-sized rect for every element, which the tour reads as
// "target not in the layout"; give the anchors a real box.
function stubRects() {
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 40, left: 40, width: 120, height: 32 }) as DOMRect;
}

describe("Tour", () => {
  afterEach(() => {
    cleanup();
  });

  it("walks the steps and finishes on the last one", async () => {
    stubRects();
    const user = userEvent.setup();
    const onFinish = renderTour();

    expect(await screen.findByRole("heading", { name: "First" })).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Second" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("skips out of the tour", async () => {
    stubRects();
    const user = userEvent.setup();
    const onFinish = renderTour();

    await user.click(await screen.findByRole("button", { name: "Skip tour" }));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("renders nothing while a target is missing", () => {
    Element.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 0, height: 0 }) as DOMRect;
    renderTour();

    expect(screen.queryByRole("heading", { name: "First" })).not.toBeInTheDocument();
  });
});
