import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { isNativeOverlaySuppressed } from "@/lib/native-overlay";

/** Advances Motion by a few animation frames. */
async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });
  }
}

function scaleOf(element: Element): number {
  const match = /scale\(([\d.]+)\)/.exec(element.getAttribute("style") ?? "");
  return match ? Number(match[1]) : 1;
}

describe("Dialog", () => {
  it("shrinks the content instead of unmounting it the moment it closes", async () => {
    const { rerender } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await frames(12);
    const content = screen.getByText("Hello").closest("[data-slot=dialog-content]")!;
    expect(scaleOf(content)).toBeCloseTo(1, 1);

    rerender(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await frames(4);

    // Still on screen, and smaller than it was — the close animation is running.
    expect(content.isConnected).toBe(true);
    expect(scaleOf(content)).toBeLessThan(1);
  });

  it("suppresses native browser webviews for the full modal lifetime", async () => {
    const { rerender } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(isNativeOverlaySuppressed()).toBe(true));

    rerender(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await frames(4);
    expect(isNativeOverlaySuppressed()).toBe(true);
    await waitFor(() => expect(isNativeOverlaySuppressed()).toBe(false));
  });
});
