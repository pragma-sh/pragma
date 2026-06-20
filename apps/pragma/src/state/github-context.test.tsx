import type { GitHubAuthStatus } from "@pragma/constants";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const githubAuthStatus = vi.fn();
const githubSignOut = vi.fn();
const setGithubSetupDismissed = vi.fn();

vi.mock("@/lib/tauri", () => ({
  githubAuthStatus: (...args: unknown[]) => githubAuthStatus(...args),
  githubSignOut: (...args: unknown[]) => githubSignOut(...args),
  setGithubSetupDismissed: (...args: unknown[]) => setGithubSetupDismissed(...args),
}));

import { GitHubProvider, useGitHub } from "./github-context";

function status(overrides: Partial<GitHubAuthStatus> = {}): GitHubAuthStatus {
  return {
    authenticated: false,
    ghAvailable: false,
    user: null,
    setupDismissed: false,
    ...overrides,
  };
}

describe("github-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubSignOut.mockResolvedValue(undefined);
    setGithubSetupDismissed.mockResolvedValue(undefined);
  });

  it("gates the setup modal when not authenticated and not dismissed", async () => {
    githubAuthStatus.mockResolvedValue(status());
    const { result } = renderHook(() => useGitHub(), { wrapper: GitHubProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsSetup).toBe(true);
    expect(result.current.authenticated).toBe(false);
  });

  it("hides the modal once authenticated", async () => {
    githubAuthStatus.mockResolvedValue(status({ authenticated: true }));
    const { result } = renderHook(() => useGitHub(), { wrapper: GitHubProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsSetup).toBe(false);
    expect(result.current.authenticated).toBe(true);
  });

  it("hides the modal once setup is dismissed", async () => {
    githubAuthStatus.mockResolvedValue(status({ setupDismissed: true }));
    const { result } = renderHook(() => useGitHub(), { wrapper: GitHubProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsSetup).toBe(false);
  });

  it("persists the skip choice and refreshes", async () => {
    githubAuthStatus.mockResolvedValueOnce(status());
    githubAuthStatus.mockResolvedValueOnce(status({ setupDismissed: true }));
    const { result } = renderHook(() => useGitHub(), { wrapper: GitHubProvider });
    await waitFor(() => expect(result.current.needsSetup).toBe(true));
    await act(async () => {
      await result.current.dismissSetup();
    });
    expect(setGithubSetupDismissed).toHaveBeenCalledWith(true);
    expect(result.current.needsSetup).toBe(false);
  });

  it("falls back to logged-out when the backend is unreachable", async () => {
    githubAuthStatus.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useGitHub(), { wrapper: GitHubProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authenticated).toBe(false);
    expect(result.current.needsSetup).toBe(true);
  });
});
