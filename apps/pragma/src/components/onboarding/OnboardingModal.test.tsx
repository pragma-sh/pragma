import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { AiProvider } from "@/state/ai-context";
import { GitHubProvider } from "@/state/github-context";
import { OnboardingProvider } from "@/state/onboarding-context";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The theme step reads the loaded theme files; the provider needs the workspace
// context, which this test does not mount.
vi.mock("@/state/theme-context", () => ({
  useTheme: () => ({ global: null, project: null, errors: {}, reload: () => undefined }),
}));

function renderModal() {
  return render(
    <AiProvider>
      <GitHubProvider>
        <OnboardingProvider>
          <OnboardingModal />
        </OnboardingProvider>
      </GitHubProvider>
    </AiProvider>,
  );
}

describe("OnboardingModal", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "onboarding_state":
          return Promise.resolve({ completed: false, tourCompleted: false });
        case "ai_status":
          return Promise.resolve({ available: false, signedIn: [] });
        case "ai_setup_dismissed":
          return Promise.resolve(false);
        case "ai_auth_methods":
          return Promise.resolve([]);
        case "github_auth_status":
          return Promise.resolve({
            authenticated: false,
            ghAvailable: false,
            user: null,
            authMethod: null,
            setupDismissed: false,
          });
        case "available_plugin_binaries":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("opens on the welcome step when onboarding has not run", async () => {
    renderModal();

    expect(await screen.findByRole("heading", { name: /welcome to pragma/i })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 7")).toBeInTheDocument();
  });

  it("advances through the steps and reports progress", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: /get started/i }));
    expect(
      await screen.findByRole("heading", { name: /sign in with github/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 7")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(
      await screen.findByRole("heading", { name: /connect an ai provider/i }),
    ).toBeInTheDocument();
  });

  it("keeps the primary action disabled until the step is done", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: /get started/i }));
    await screen.findByRole("heading", { name: /sign in with github/i });

    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeEnabled();
  });

  it("skips the whole flow from any step", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: /get started/i }));
    await user.click(await screen.findByRole("button", { name: /skip setup/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_onboarding_completed", { completed: true }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("skipping GitHub persists that step's own dismissal", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: /get started/i }));
    await user.click(await screen.findByRole("button", { name: /^skip$/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_github_setup_dismissed", { dismissed: true }),
    );
  });

  it("closes and records completion after the last step", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: /get started/i }));
    await user.click(await screen.findByRole("button", { name: /^skip$/i }));
    await user.click(await screen.findByRole("button", { name: /^skip$/i }));
    // No agent CLIs are on this machine in the mock, so that step is complete.
    await user.click(await screen.findByRole("button", { name: /^continue$/i }));
    await user.click(await screen.findByRole("button", { name: /^skip$/i }));
    await user.click(await screen.findByRole("button", { name: /^skip$/i }));
    await user.click(await screen.findByRole("button", { name: /later/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_onboarding_completed", { completed: true }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stays closed once onboarding is complete", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "onboarding_state"
        ? Promise.resolve({ completed: true, tourCompleted: true })
        : Promise.resolve(null),
    );
    renderModal();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("onboarding_state"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
