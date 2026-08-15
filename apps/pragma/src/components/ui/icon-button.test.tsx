import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { IconButton, IconTooltip } from "./icon-button";

describe("IconButton", () => {
  it("names the button after its label and shows that label on hover", async () => {
    const user = userEvent.setup();
    render(<IconButton label="New tab">+</IconButton>);

    const button = screen.getByRole("button", { name: "New tab" });
    await user.hover(button);

    expect(await screen.findByRole("tooltip")).toHaveTextContent("New tab");
  });

  it("keeps an explicit aria-label when the tooltip needs to stay short", () => {
    render(
      <IconButton aria-label="Delete worktree feature-x" label="Delete">
        x
      </IconButton>,
    );

    expect(screen.getByRole("button", { name: "Delete worktree feature-x" })).toBeInTheDocument();
  });

  it("drops the tooltip but keeps the name when tooltipDisabled is set", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="New tab" tooltipDisabled>
        +
      </IconButton>,
    );

    await user.hover(screen.getByRole("button", { name: "New tab" }));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("IconTooltip", () => {
  it("wraps a control that cannot be a Button", async () => {
    const user = userEvent.setup();
    render(
      <IconTooltip label="Close tab">
        <button aria-label="Close tab" type="button" />
      </IconTooltip>,
    );

    await user.hover(screen.getByRole("button", { name: "Close tab" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Close tab");
  });
});
