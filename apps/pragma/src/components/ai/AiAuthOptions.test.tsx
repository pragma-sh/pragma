import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiAuthOptions } from "@/components/ai/AiAuthOptions";
import { AiProvider } from "@/state/ai-context";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const methods = [
  { kind: "oauth", provider: "anthropic", label: "Claude Code", featured: true },
  { kind: "api-key", provider: "openrouter", label: "OpenRouter", featured: true },
];

function mockCommands(): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "ai_auth_methods") return Promise.resolve(methods);
    if (command === "ai_status") return Promise.resolve({ available: false, signedIn: [] });
    if (command === "ai_setup_dismissed") return Promise.resolve(false);
    return Promise.resolve(undefined);
  });
}

function callsTo(command: string): number {
  return invokeMock.mock.calls.filter((call) => call[0] === command).length;
}

describe("AiAuthOptions", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    mockCommands();
  });

  it("keeps one login running when the parent re-renders", async () => {
    const view = render(
      <AiProvider>
        <AiAuthOptions onProviderAuthScreenChange={() => {}} />
      </AiProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    await waitFor(() => expect(callsTo("ai_login")).toBe(1));

    // A fresh callback identity is what a parent re-render hands down; the login
    // must not be cancelled and restarted (that would kill the sidecar mid-OAuth
    // and re-open the browser).
    view.rerender(
      <AiProvider>
        <AiAuthOptions onProviderAuthScreenChange={() => {}} />
      </AiProvider>,
    );

    await waitFor(() => expect(screen.getByText(/Signing in to/)).toBeTruthy());
    expect(callsTo("ai_login")).toBe(1);
    expect(callsTo("ai_login_cancel")).toBe(0);
  });
});
