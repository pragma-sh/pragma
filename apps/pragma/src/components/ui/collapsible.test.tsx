import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });
  }
}

describe("Collapsible", () => {
  it("keeps its content mounted and animates the height rather than toggling it", async () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent className="px-2">Body</CollapsibleContent>
      </Collapsible>,
    );

    const body = screen.getByText("Body");
    const animated = body.parentElement!;
    expect(animated).toHaveClass("overflow-hidden");

    fireEvent.click(screen.getByText("Toggle"));
    await frames(3);

    // Collapsed content stays in the DOM while its box shrinks, so there is
    // something to animate; Radix on its own would have unmounted it already.
    expect(body.isConnected).toBe(true);
    expect(animated.style.height).not.toBe("");
  });
});
