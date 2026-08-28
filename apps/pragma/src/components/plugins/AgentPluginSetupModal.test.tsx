import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LockedPlugin } from "@pragma/plugin-registry";

import { AgentPluginSetupModal } from "./AgentPluginSetupModal";

const installMock = vi.fn();
const setDismissedMock = vi.fn();
const toastErrorMock = vi.fn();
const officialPlugin = {
  package: "@pragma-sh/opencode-plugin",
  version: "1.0.0",
  manifest: {
    name: "OpenCode",
    categories: ["agent-plugin"],
    agentBinary: "opencode",
  },
} as LockedPlugin;

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

vi.mock("@/lib/plugin-registry", () => ({
  bundledOfficialPluginLock: () => [officialPlugin],
  installLockedPlugin: (...args: unknown[]) => installMock(...args),
}));

vi.mock("@/lib/tauri", () => ({
  availablePluginBinaries: () => Promise.resolve(["opencode"]),
  pluginOnboardingDismissed: () => Promise.resolve(false),
  setPluginOnboardingDismissed: (...args: unknown[]) => setDismissedMock(...args),
}));

vi.mock("@/state/ai-context", () => ({
  useAi: () => ({ loading: false, needsSetup: false }),
}));

vi.mock("@/state/github-context", () => ({
  useGitHub: () => ({ loading: false, needsSetup: false }),
}));

describe("AgentPluginSetupModal", () => {
  beforeEach(() => {
    installMock.mockReset().mockResolvedValue(undefined);
    setDismissedMock.mockReset().mockResolvedValue(undefined);
    toastErrorMock.mockReset();
  });

  it("closes before recommended plugin installation settles", async () => {
    const user = userEvent.setup();
    installMock.mockReturnValue(new Promise(() => undefined));
    render(<AgentPluginSetupModal />);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Install selected agents" }));

    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
    expect(installMock).toHaveBeenCalledWith(officialPlugin);
    expect(setDismissedMock).toHaveBeenCalledWith(true);
  });

  it("reports recommended plugin failure after closing", async () => {
    const user = userEvent.setup();
    installMock.mockRejectedValue(new Error("404 Not Found"));
    render(<AgentPluginSetupModal />);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Install selected agents" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Recommended agent plugin installation failed", {
        description: "OpenCode: 404 Not Found",
      }),
    );
  });
});
