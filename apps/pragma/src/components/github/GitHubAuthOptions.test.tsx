import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { GitHubProvider } from "@/state/github-context";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function status(authenticated: boolean) {
  return {
    authenticated,
    ghAvailable: true,
    user: authenticated ? { login: "octocat" } : null,
    authMethod: authenticated ? "gh" : null,
    setupDismissed: false,
  };
}

describe("GitHubAuthOptions", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("clears the CLI button's busy state once sign-in succeeds", async () => {
    let authenticated = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === "github_auth_status") return Promise.resolve(status(authenticated));
      if (command === "github_use_cli_token") {
        authenticated = true;
        return Promise.resolve({ login: "octocat" });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(
      <GitHubProvider>
        <GitHubAuthOptions />
      </GitHubProvider>,
    );

    const cli = await screen.findByRole("button", { name: /use github cli login/i });
    await user.click(cli);

    // The surface stays mounted after a successful sign-in (the onboarding step
    // does exactly this), so the button must come back out of its busy state.
    await waitFor(() => expect(cli).toBeEnabled());
  });
});
