import { constants } from "@pragma/constants";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders the app name from the shared constants", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: constants.app.name })).toBeInTheDocument();
  });

  it("shows backend info after pinging the Rust command", async () => {
    invokeMock.mockResolvedValue({
      name: "Pragma",
      identifier: "com.pragma.app",
      version: "9.9.9",
    });

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /ping/i }));

    expect(await screen.findByText(/9\.9\.9/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("app_info");
  });
});
