import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InstallUpdateButton } from "./InstallUpdateButton";
import { useUpdates } from "@/state/updates-context";

vi.mock("@/state/updates-context", () => ({
  useUpdates: vi.fn(),
}));

describe("InstallUpdateButton", () => {
  it("hides when no offer is waiting", () => {
    vi.mocked(useUpdates).mockReturnValue({
      runtime: null,
      offer: null,
      checking: false,
      applying: false,
      checkNow: vi.fn(),
      install: vi.fn(),
    });
    const { container } = render(<InstallUpdateButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it("installs when clicked", () => {
    const install = vi.fn();
    vi.mocked(useUpdates).mockReturnValue({
      runtime: null,
      offer: { available: true, apply: "reload", version: "0.0.1" },
      checking: false,
      applying: false,
      checkNow: vi.fn(),
      install,
    });
    render(<InstallUpdateButton />);
    fireEvent.click(screen.getByRole("button", { name: "Install Update" }));
    expect(install).toHaveBeenCalled();
  });
});
