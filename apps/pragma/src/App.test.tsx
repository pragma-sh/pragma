import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

const invokeResults: Record<string, unknown> = {
  list_projects: [],
  get_projects_directory: "/tmp",
  ai_status: { available: false, signedIn: [] },
  ai_setup_dismissed: true,
  read_plugin_manifests: [],
  gateway_connection_info: { baseUrl: "http://127.0.0.1:0", token: "test" },
  get_update_runtime: {
    platform: "darwin-aarch64",
    isDev: true,
    checkUrl: "http://localhost:3000/api/updates",
    versions: { ui: "0.0.0", app: "0.0.0", server: "0.0.0", protocol: "0.0.0" },
  },
  check_for_update: { available: false },
  read_config: { exists: true, path: "/tmp/config.json", contents: "{}" },
};

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
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(invokeResults[command] ?? null),
    );
  });

  it("renders the terminal workspace empty state", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /what will you build with pragma/i }),
    ).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_projects");
  });
});
