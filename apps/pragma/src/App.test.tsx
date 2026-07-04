import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
  transformCallback: () => 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "test",
    onFocusChanged: () => Promise.resolve(() => undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: () => undefined,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/terminal-manager", () => ({
  TERMINAL_FONT_FAMILY: "monospace",
  terminalManager: {
    activate: vi.fn(),
    dispose: vi.fn(),
    mount: vi.fn(),
    resize: vi.fn(),
  },
}));

// `@pragma/plugin` is a compile-time stub that fails loudly without
// `globalThis.__PRAGMA__` installed. The Tauri mocks above are hoisted to
// the top of the file, so the bridge's transitive Tauri imports resolve
// to the stubs and the bridge installs cleanly.
import "@/plugins/bootstrap-bridge";
import App from "./App";

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
      // Keep the first-run AI setup modal closed so it doesn't aria-hide the
      // workspace under test: report AI as already-dismissed.
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(true);
      }
      // PluginProvider reads plugin manifests on mount; under test there are
      // none, so return an empty array rather than letting the call fall
      // through to the real Tauri internals.
      if (command === "read_plugin_manifests") {
        return Promise.resolve([]);
      }
      // No local gateway in tests; report a benign connection info so the
      // SDK bridge wires up without trying to talk to a running process.
      if (command === "gateway_connection_info") {
        return Promise.resolve({ baseUrl: "http://127.0.0.1:0", token: "test" });
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
