import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiSetupModal } from "@/components/ai/AiSetupModal";
import { AiProvider } from "@/state/ai-context";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function renderModal() {
  return render(
    <AiProvider>
      <AiSetupModal />
    </AiProvider>,
  );
}

describe("AiSetupModal", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
  });

  it("opens when AI setup is needed", async () => {
    renderModal();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /enable ai features/i })).toBeInTheDocument();
  });

  it("hides Done before a provider is authenticated", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "Skip for now" })).toHaveAttribute(
      "data-variant",
      "outline",
    );
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });

  it("closes and persists setup dismissal when skipped", async () => {
    renderModal();

    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith("set_ai_setup_dismissed", { dismissed: true });
  });

  it("shows Done as the preferred action after a provider is authenticated", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: true, signedIn: ["github-copilot"] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    renderModal();

    expect(await screen.findByRole("button", { name: "Done" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(screen.getByRole("button", { name: "Skip for now" })).toHaveAttribute(
      "data-variant",
      "outline",
    );
  });

  it("keeps all providers in a scrollable list after More options", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([
          { provider: "featured", label: "Featured Provider", kind: "oauth", featured: true },
          { provider: "extra", label: "Extra Provider", kind: "api-key", featured: false },
        ]);
      }
      return Promise.resolve(null);
    });

    renderModal();
    await userEvent.click(await screen.findByRole("button", { name: "More options" }));

    expect(screen.getByTestId("ai-provider-list")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("button", { name: /extra provider/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });

  it("hides setup actions on an individual provider auth screen", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: true, signedIn: ["github-copilot"] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([
          { provider: "openrouter", label: "OpenRouter", kind: "api-key", featured: true },
        ]);
      }
      return Promise.resolve(null);
    });

    renderModal();
    await userEvent.click(await screen.findByRole("button", { name: /openrouter/i }));

    expect(await screen.findByPlaceholderText("API key")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("opens when pi auth already exists but Pragma onboarding is incomplete", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: true, signedIn: ["github-copilot"] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    renderModal();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("stays closed when setup was dismissed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    renderModal();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("ai_setup_dismissed"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens when ai_status fails but setup was not dismissed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.reject(new Error("sidecar unavailable"));
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      if (command === "ai_auth_methods") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    renderModal();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
