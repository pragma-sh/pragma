import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  readConfig: mocks.readConfig,
  writeConfig: mocks.writeConfig,
}));

import {
  disableNonGitWarning,
  mainWorktreeLabel,
  nonGitWarningEnabled,
  projectIsGit,
  worktreeDisplayLabel,
} from "./non-git-project";

afterEach(() => vi.clearAllMocks());

function config(value: unknown) {
  mocks.readConfig.mockResolvedValue({ exists: true, path: "", contents: JSON.stringify(value) });
}

describe("non-git projects", () => {
  it("treats a missing flag as a git project", () => {
    expect(projectIsGit({})).toBe(true);
    expect(projectIsGit({ isGit: true })).toBe(true);
    expect(projectIsGit({ isGit: false })).toBe(false);
  });

  it("labels the main worktree root when there is no git", () => {
    expect(mainWorktreeLabel({ isGit: true })).toBe("main");
    expect(mainWorktreeLabel({ isGit: false })).toBe("root");
    const child = { isMain: false, title: null, branch: "feature" };
    expect(worktreeDisplayLabel(child, { isGit: true })).toBe("feature");
    expect(worktreeDisplayLabel({ ...child, isMain: true }, { isGit: false })).toBe("root");
  });

  it("reads the warning setting, defaulting on", async () => {
    config({});
    expect(await nonGitWarningEnabled()).toBe(true);
    config({ other: { nonGitProjectWarning: false } });
    expect(await nonGitWarningEnabled()).toBe(false);
    mocks.readConfig.mockResolvedValue({ exists: true, path: "", contents: "{not json" });
    expect(await nonGitWarningEnabled()).toBe(true);
  });

  it("persists don't-show-again without dropping other settings", async () => {
    config({ tunnel: { enabled: true }, other: { autoDownload: false } });

    await disableNonGitWarning();

    const written = JSON.parse(mocks.writeConfig.mock.calls[0]?.[1] as string) as unknown;
    expect(mocks.writeConfig.mock.calls[0]?.[0]).toBe("global");
    expect(written).toEqual({
      tunnel: { enabled: true },
      other: { autoDownload: false, nonGitProjectWarning: false },
    });
  });
});
