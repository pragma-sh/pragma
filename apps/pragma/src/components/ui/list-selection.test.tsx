import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

describe("list selection", () => {
  it("moves command selection with arrow keys", async () => {
    render(
      <Command>
        <CommandInput aria-label="Search" />
        <CommandList>
          <CommandGroup>
            <CommandItem value="first">First</CommandItem>
            <CommandItem value="second">Second</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });

    expect(screen.getByText("Second").closest("[cmdk-item]")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("moves dropdown highlight with arrow keys", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const menu = screen.getByRole("menu");
    menu.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveAttribute("data-highlighted"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Second" })).toHaveAttribute("data-highlighted"),
    );
  });
});
