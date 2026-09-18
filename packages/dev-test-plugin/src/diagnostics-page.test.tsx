import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
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

  it("rehydrates a saved count and increments from it", () => {
    const notify = vi.fn();
    setBridge(
      createBridge({
        useNotify: () => notify,
        // The real host returns the default first and hydrates the stored value
        // asynchronously; the component must display and grow the hydrated count.
        useStoredState: <T,>(
          _key: string,
          initialValue: T,
        ): [T, (next: T | ((prev: T) => T)) => void] => {
          const [value, setValue] = React.useState<T>(initialValue);
          React.useEffect(() => {
            setValue(7 as unknown as T);
          }, []);
          return [value, setValue];
        },
      }),
    );

    render(<DevTestDiagnosticsPage />);
    expect(screen.getByTestId("diagnostics-checks")).toHaveTextContent("7");

    fireEvent.click(screen.getByRole("button", { name: "Run check" }));

    expect(screen.getByTestId("diagnostics-checks")).toHaveTextContent("8");
    expect(notify).toHaveBeenCalledWith("Diagnostics check recorded", { variant: "success" });
  });
});
