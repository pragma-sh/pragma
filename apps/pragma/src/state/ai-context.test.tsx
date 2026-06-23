import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiProvider, useAi } from "@/state/ai-context";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("AiProvider", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("needs setup when AI is unavailable and setup was not dismissed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useAi(), { wrapper: AiProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsSetup).toBe(true);
  });

  it("needs setup when onboarding was not dismissed, even if pi auth already exists", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: true, signedIn: ["github-copilot"] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useAi(), { wrapper: AiProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.needsSetup).toBe(true);
  });

  it("does not need setup when the user previously skipped", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.resolve({ available: false, signedIn: [] });
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useAi(), { wrapper: AiProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsSetup).toBe(false);
  });

  it("still needs setup when ai_status fails but setup was not dismissed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_status") {
        return Promise.reject(new Error("sidecar unavailable"));
      }
      if (command === "ai_setup_dismissed") {
        return Promise.resolve(false);
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useAi(), { wrapper: AiProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.needsSetup).toBe(true);
  });
});
