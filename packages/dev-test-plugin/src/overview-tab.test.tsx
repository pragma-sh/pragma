import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OverviewTab } from "./overview-tab";
import { createBridge, setBridge } from "./test/bridge";

describe("OverviewTab", () => {
  it("renders the active project name and the host Button/Kbd primitives", () => {
    setBridge(createBridge({ useProject: () => ({ id: "p", name: "Pragma", path: "/p" }) }));

    render(<OverviewTab />);

    expect(screen.getByText("Active project: Pragma")).toBeInTheDocument();
    expect(screen.getByText(/⌘K/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Plugin Report" })).toBeInTheDocument();
  });
});
