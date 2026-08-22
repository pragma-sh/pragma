import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";
import type { LockedPlugin } from "@pragma/plugin-registry";

import { AGENT_COMMAND_SUBMITTED_EVENT } from "@/lib/agent-plugin-prompt";

import { AgentPluginInstallPrompt } from "./AgentPluginInstallPrompt";

const installMock = vi.fn();
const setDismissedMock = vi.fn();
const toastErrorMock = vi.fn();
const officialPlugin = {
  package: "@pragma-sh/opencode-plugin",
  version: "1.0.0",
  manifest: { name: "OpenCode", agentBinary: "opencode" },
} as LockedPlugin;

vi.mock("@/lib/plugin-registry", () => ({
  bundledOfficialPluginLock: () => [officialPlugin],
  installLockedPlugin: (...args: unknown[]) => installMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

vi.mock("@/lib/tauri", () => ({
  agentPluginPromptDismissed: () => Promise.resolve(false),
  setAgentPluginPromptDismissed: (...args: unknown[]) => setDismissedMock(...args),
}));

vi.mock("@/plugins/registry", () => ({
  useActivePlugins: () => [
    {
      pluginId: "pragma.opencode",
      scope: "bundled",
      status: "loaded",
      config: {},
      definition: {
        agents: [{ launch: { command: ["opencode"] } }],
      } as PluginDefinition,
    },
  ],
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ selectedProjectId: "project-1" }),
}));

async function runOpenCode(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  act(() => {
    window.dispatchEvent(
      new CustomEvent(AGENT_COMMAND_SUBMITTED_EVENT, { detail: { command: "opencode" } }),
    );
  });
  await screen.findByRole("dialog");
}

describe("AgentPluginInstallPrompt", () => {
  beforeEach(() => {
    installMock.mockReset().mockResolvedValue(undefined);
    setDismissedMock.mockReset().mockResolvedValue(undefined);
    toastErrorMock.mockReset();
  });

  it("installs matching plugin while allowing current command to continue", async () => {
    const user = userEvent.setup();
    render(<AgentPluginInstallPrompt />);
    await runOpenCode();

    expect(screen.getByText("Connect OpenCode to Pragma?")).toBeInTheDocument();
    expect(screen.getByText(/current command will keep running/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install plugin" }));

    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
    expect(installMock).toHaveBeenCalledWith(officialPlugin);
  });

  it("reports a deferred installation failure after closing", async () => {
    const user = userEvent.setup();
    let rejectInstall: ((cause: unknown) => void) | undefined;
    installMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectInstall = reject;
      }),
    );
    render(<AgentPluginInstallPrompt />);
    await runOpenCode();

    await user.click(screen.getByRole("button", { name: "Install plugin" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    rejectInstall!(new Error("404 Not Found"));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("OpenCode installation failed", {
        description: "404 Not Found",
      }),
    );
  });

  it("persists do-not-show-again choice", async () => {
    const user = userEvent.setup();
    render(<AgentPluginInstallPrompt />);
    await runOpenCode();

    await user.click(screen.getByRole("button", { name: "Don't show again" }));

    await waitFor(() => expect(setDismissedMock).toHaveBeenCalledWith(true));
  });
});
