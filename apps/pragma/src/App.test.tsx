import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: {
    activate: vi.fn(),
    dispose: vi.fn(),
    mount: vi.fn(),
    resize: vi.fn(),
  },
}));

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_projects") {
        return Promise.resolve([]);
      }
      if (command === "get_projects_directory") {
        return Promise.resolve("/tmp");
      }
      return Promise.resolve(null);
    });
  });

  it("renders the terminal workspace empty state", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: /no projects yet/i })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_projects");
  });
});
