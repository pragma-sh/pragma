import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsWorkspace } from "./SettingsWorkspace";
import {
  aiAuthMethods,
  gatewayDevices,
  readConfig,
  readPluginManifests,
  writeConfig,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { useGitHub } from "@/state/github-context";

const closeSettings = vi.fn();
const signOut = vi.fn();

vi.mock("@/components/dialogs/PairDeviceDialog", () => ({
  PairDeviceSettings: () => <div>Pairing controls</div>,
}));

vi.mock("@/components/github/GitHubAuthOptions", () => ({
  GitHubAuthOptions: () => <div>GitHub auth options</div>,
}));

vi.mock("@/components/ai/AiAuthOptions", () => ({
  AiAuthOptions: () => <div>AI auth options</div>,
}));

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({ closeSettings }),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    activeProject: { name: "Pragma", path: "/home/user/pragma" },
    selectedProjectId: "project-1",
  }),
}));

vi.mock("@/state/github-context", () => ({
  useGitHub: vi.fn(),
}));

vi.mock("@/state/ai-context", () => ({
  useAi: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  aiAuthMethods: vi.fn(),
  gatewayDevices: vi.fn(),
  readConfig: vi.fn(),
  readPluginManifests: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function gitHubValue(overrides: Partial<ReturnType<typeof useGitHub>> = {}) {
  return {
    status: null,
    loading: false,
    authenticated: false,
    needsSetup: false,
    refresh: vi.fn(),
    dismissSetup: vi.fn(),
    signOut,
    ...overrides,
  };
}

describe("SettingsWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readConfig).mockResolvedValue({
      exists: true,
      path: "/home/user/.pragma/config.json",
      contents: JSON.stringify({
        plugins: [{ path: "./plugins/one", config: { enabled: true } }, { path: "./plugins/two" }],
        customSetting: true,
      }),
    });
    vi.mocked(writeConfig).mockResolvedValue();
    vi.mocked(gatewayDevices).mockResolvedValue([]);
    vi.mocked(aiAuthMethods).mockResolvedValue([
      { provider: "anthropic", label: "Anthropic", kind: "oauth", featured: true },
    ]);
    vi.mocked(readPluginManifests).mockResolvedValue([
      {
        specifier: "./plugins/one",
        scope: "global",
        projectPath: null,
        config: null,
        manifest: {
          name: "@pragma/plugin-one",
          version: "1.0.0",
          dir: "/plugins/one",
          mainPath: "/plugins/one/index.js",
          modifiedMs: null,
        },
        error: null,
      },
    ]);
    vi.mocked(useGitHub).mockReturnValue(gitHubValue());
    vi.mocked(useAi).mockReturnValue({
      status: { available: true, signedIn: ["anthropic"] },
      loading: false,
      available: true,
      needsSetup: false,
      refresh: vi.fn(),
      dismissSetup: vi.fn(),
    });
  });

  it("shows loaded plugins by name with delete controls only", async () => {
    render(<SettingsWorkspace />);

    expect(await screen.findByText("@pragma/plugin-one")).toBeInTheDocument();
    // Unresolvable entries fall back to the last path segment.
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.queryByText("./plugins/one")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete plugin @pragma/plugin-one" }));

    await waitFor(() =>
      expect(writeConfig).toHaveBeenCalledWith(
        "global",
        `${JSON.stringify(
          {
            plugins: [{ path: "./plugins/two" }],
            customSetting: true,
          },
          null,
          2,
        )}\n`,
        "project-1",
      ),
    );
    expect(screen.queryByText("@pragma/plugin-one")).not.toBeInTheDocument();
  });

  it("keeps supported non-plugin settings in UI controls", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "Mobile & Gateway" }));

    expect(screen.getByText("Pairing controls")).toBeInTheDocument();
    expect(screen.getByLabelText("Command")).toBeInTheDocument();
    expect(screen.getByLabelText("URL pattern")).toBeInTheDocument();
  });

  it("resyncs tunnel inputs after a failed save reloads config", async () => {
    vi.mocked(readConfig)
      .mockResolvedValueOnce({
        exists: true,
        path: "/home/user/.pragma/config.json",
        contents: JSON.stringify({
          tunnel: { command: "stale-command", urlPattern: "https://stale.example/{port}" },
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        path: "/home/user/.pragma/config.json",
        contents: JSON.stringify({
          tunnel: { command: "fresh-command", urlPattern: "https://fresh.example/{port}" },
        }),
      });
    vi.mocked(writeConfig).mockRejectedValueOnce(new Error("disk write failed"));
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "Mobile & Gateway" }));
    const command = screen.getByLabelText("Command");
    const urlPattern = screen.getByLabelText("URL pattern");
    expect(command).toHaveValue("stale-command");
    expect(urlPattern).toHaveValue("https://stale.example/{port}");

    fireEvent.change(command, { target: { value: "unsaved-command" } });
    fireEvent.blur(command);

    await waitFor(() => expect(readConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(command).toHaveValue("fresh-command");
      expect(urlPattern).toHaveValue("https://fresh.example/{port}");
    });
  });

  it("shows the GitHub auth options when signed out", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(screen.getByText("GitHub auth options")).toBeInTheDocument();
  });

  it("shows the GitHub account with auth method and sign out when signed in", async () => {
    vi.mocked(useGitHub).mockReturnValue(
      gitHubValue({
        authenticated: true,
        status: {
          authenticated: true,
          ghAvailable: false,
          user: { login: "octocat", name: "The Octocat", avatarUrl: "https://avatars/x" },
          authMethod: "deviceFlow",
          setupDismissed: true,
        },
      }),
    );
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    expect(screen.getByText("The Octocat")).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.getByText("OAuth device flow")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });

  it("lists connected AI providers and offers the add-provider options", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "AI Providers" }));

    expect(await screen.findByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("AI auth options")).toBeInTheDocument();
  });
});
