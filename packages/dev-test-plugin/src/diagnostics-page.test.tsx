import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DevTestDiagnosticsPage } from "./diagnostics-page";
import { createBridge, setBridge } from "./test/bridge";

describe("DevTestDiagnosticsPage", () => {
  it("reports host state and counts a recorded check", () => {
    const notify = vi.fn();
    setBridge(
      createBridge({
        useProject: () => ({ id: "p-1", name: "Pragma", path: "/repo" }),
        useTheme: () => "dark",
        useNotify: () => notify,
      }),
    );

    render(<DevTestDiagnosticsPage />);
    expect(screen.getByTestId("diagnostics-project")).toHaveTextContent("Pragma");
    expect(screen.getByTestId("diagnostics-theme")).toHaveTextContent("dark");

    fireEvent.click(screen.getByRole("button", { name: "Run check" }));

    expect(screen.getByTestId("diagnostics-checks")).toHaveTextContent("1");
    expect(notify).toHaveBeenCalledWith("Diagnostics check recorded", { variant: "success" });
  });
});
