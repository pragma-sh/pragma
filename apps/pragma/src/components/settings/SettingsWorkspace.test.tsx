import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import { SettingsWorkspace } from "./SettingsWorkspace";
import {
  aiAuthMethods,
  aiLogout,
  gatewayDevices,
  listWslDistros,
  readConfig,
  readPluginManifests,
  writeConfig,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { useGitHub } from "@/state/github-context";
import { clearPlugins, setPluginsForScope } from "@/plugins/registry";

const closeSettings = vi.fn();
const signOut = vi.fn();

vi.mock("@/components/dialogs/PairDeviceDialog", () => ({
  PragmaGoSettings: ({
    webEnabled,
    onWebEnabledChange,
  }: {
    webEnabled: boolean;
    onWebEnabledChange: (enabled: boolean) => void;
  }) => (
    <button type="button" onClick={() => onWebEnabledChange(!webEnabled)}>
      Web access {webEnabled ? "enabled" : "disabled"}
    </button>
  ),
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
  aiLogout: vi.fn(),
  gatewayDevices: vi.fn(),
  listWslDistros: vi.fn(),
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
    clearPlugins();
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
    vi.mocked(listWslDistros).mockResolvedValue({ isWindows: false, distros: [] });
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

  it("renders plugin settings pages from the Settings navigation", async () => {
    const definition = {
      name: "Plugin Settings",
      ui: {
        settingsPages: [
          { id: "account", title: "Plugin Account", component: () => <div>Account settings</div> },
        ],
      },
      __apiVersion: "0.4.0",
    } as PluginDefinition;
    setPluginsForScope("global", null, [
      {
        pluginId: "plugin-settings",
        version: "1.0.0",
        scope: "global",
        status: "loaded",
        config: undefined,
        definition,
      },
    ]);

    render(<SettingsWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Plugin Account" }));

    expect(screen.getByText("Account settings")).toBeInTheDocument();
  });

  it("hides the WSL section off Windows", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    expect(screen.queryByRole("button", { name: "WSL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("shows the WSL section on Windows with a distribution installed", async () => {
    vi.mocked(listWslDistros).mockResolvedValue({
      isWindows: true,
      distros: [{ name: "Ubuntu", version: 2, default: true, running: false }],
    });
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(await screen.findByRole("button", { name: "WSL" }));

    expect(await screen.findByText("Default shell")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(closeSettings).toHaveBeenCalled();
  });

  it("leaves Escape to an open overlay", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    dialog.remove();

    expect(closeSettings).not.toHaveBeenCalled();
  });

  it("keeps supported non-plugin settings in UI controls", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "Pragma Go" }));

    expect(screen.getByText("Web access disabled")).toBeInTheDocument();
    expect(screen.getByLabelText("Command")).toBeInTheDocument();
    expect(screen.getByLabelText("URL pattern")).toBeInTheDocument();
  });

  it("persists the web access setting", async () => {
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "Pragma Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Web access disabled" }));

    await waitFor(() =>
      expect(writeConfig).toHaveBeenCalledWith(
        "global",
        `${JSON.stringify(
          {
            plugins: [
              { path: "./plugins/one", config: { enabled: true } },
              { path: "./plugins/two" },
            ],
            customSetting: true,
            gateway: { webEnabled: true },
          },
          null,
          2,
        )}\n`,
        "project-1",
      ),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Pragma Go" }));
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

  it("signs out one AI provider and re-reads status", async () => {
    const refresh = vi.fn();
    vi.mocked(useAi).mockReturnValue({
      status: { available: true, signedIn: ["anthropic", "openai-codex"] },
      loading: false,
      available: true,
      needsSetup: false,
      refresh,
      dismissSetup: vi.fn(),
    });
    vi.mocked(aiLogout).mockResolvedValue({ available: true, signedIn: ["anthropic"] });
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "AI Providers" }));

    // Providers with no auth-method entry still render (and sign out) by id.
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of openai-codex" }));

    await waitFor(() => expect(aiLogout).toHaveBeenCalledWith("openai-codex"));
    expect(refresh).toHaveBeenCalled();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Signed out of openai-codex.");
  });

  it("keeps the provider listed when signing out fails", async () => {
    vi.mocked(aiLogout).mockRejectedValue(new Error("sidecar unavailable"));
    render(<SettingsWorkspace />);

    await screen.findByText("Loaded plugins");
    fireEvent.click(screen.getByRole("button", { name: "AI Providers" }));

    const button = await screen.findByRole("button", { name: "Sign out of Anthropic" });
    fireEvent.click(button);

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith("sidecar unavailable"));
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
});
