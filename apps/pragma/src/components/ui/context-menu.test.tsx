import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isNativeOverlaySuppressed } from "@/lib/native-overlay";

afterEach(cleanup);

describe("ContextMenu", () => {
  it("opens custom menu content on right click and suppresses native overlays", async () => {
    render(
      <div onContextMenu={(event) => event.preventDefault()}>
        <ContextMenu>
          <ContextMenuTrigger>Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Rename</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>,
    );

    fireEvent.contextMenu(screen.getByText("Target"));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    await waitFor(() => expect(isNativeOverlaySuppressed()).toBe(true));
  });
});
