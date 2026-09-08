import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

vi.mock("@/lib/native-overlay", () => ({
  useSuppressNativeOverlayWhile: vi.fn(),
}));

import { NestedDropdown, NestedDropdownGroup, NestedDropdownItem } from "./NestedDropdown";

function openRoot() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Pick" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function openSubmenu(name: string | RegExp) {
  fireEvent.pointerMove(screen.getByRole("menuitem", { name }), { pointerType: "mouse" });
}

describe("NestedDropdown", () => {
  it("opens a nested submenu on hover and selects an item", async () => {
    const onSelect = vi.fn();
    render(
      <NestedDropdown modal={false} trigger={<Button type="button">Pick</Button>}>
        <NestedDropdownGroup label="Effort">
          <NestedDropdownItem selected onSelect={() => onSelect("auto")}>
            Auto
          </NestedDropdownItem>
          <NestedDropdownItem onSelect={() => onSelect("high")}>High</NestedDropdownItem>
        </NestedDropdownGroup>
      </NestedDropdown>,
    );

    openRoot();
    openSubmenu(/Effort/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));

    expect(onSelect).toHaveBeenCalledWith("high");
  });

  it("filters a searchable submenu without dropping nested hover children", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    render(
      <NestedDropdown modal={false} trigger={<Button type="button">Pick</Button>}>
        <NestedDropdownGroup
          emptyText="No matching models."
          label="OpenCode"
          searchLabel="Search models"
          searchPlaceholder="Search models..."
          searchable
          onOpen={onOpen}
        >
          <NestedDropdownItem searchValue="GPT 5.6 gpt-5.6" onSelect={() => onSelect("gpt-5.6")}>
            GPT 5.6
          </NestedDropdownItem>
          <NestedDropdownGroup label="GPT 5.6 Codex" searchValue="GPT 5.6 Codex gpt-5.6-codex">
            <NestedDropdownItem onSelect={() => onSelect("high")}>High</NestedDropdownItem>
          </NestedDropdownGroup>
        </NestedDropdownGroup>
      </NestedDropdown>,
    );

    openRoot();
    openSubmenu(/OpenCode/);
    const search = await screen.findByRole("searchbox", { name: "Search models" });
    expect(onOpen).toHaveBeenCalled();

    await user.type(search, "codex");
    const modelMenu = screen
      .getByRole("searchbox", { name: "Search models" })
      .closest<HTMLElement>("[data-slot=dropdown-menu-sub-content]");
    if (!modelMenu) throw new Error("expected model submenu");

    expect(within(modelMenu).getByText("GPT 5.6 Codex")).toBeVisible();
    expect(within(modelMenu).queryByText("GPT 5.6", { exact: true })).not.toBeInTheDocument();

    fireEvent.pointerMove(within(modelMenu).getByRole("menuitem", { name: /GPT 5.6 Codex/ }), {
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(onSelect).toHaveBeenCalledWith("high");
  });
});
