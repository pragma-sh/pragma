import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addProject: vi.fn(),
  initProjectGit: vi.fn(),
  pickDirectory: vi.fn(),
  projectDirectoryIsGit: vi.fn(),
  nonGitWarningEnabled: vi.fn(),
  disableNonGitWarning: vi.fn(),
  reload: vi.fn(),
  selectProject: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  addProject: mocks.addProject,
  cloneProject: vi.fn(),
  connectRemoteProject: vi.fn(),
  getProjectsDirectory: () => Promise.resolve("/home/user"),
  initProjectGit: mocks.initProjectGit,
  pickDirectory: mocks.pickDirectory,
  projectDirectoryIsGit: mocks.projectDirectoryIsGit,
}));

vi.mock("@/lib/non-git-project", () => ({
  nonGitWarningEnabled: mocks.nonGitWarningEnabled,
  disableNonGitWarning: mocks.disableNonGitWarning,
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ reload: mocks.reload, selectProject: mocks.selectProject }),
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

const onOpenChange = vi.fn();

beforeEach(() => {
  mocks.pickDirectory.mockResolvedValue("/home/user/notes");
  mocks.projectDirectoryIsGit.mockResolvedValue(false);
  mocks.nonGitWarningEnabled.mockResolvedValue(true);
  mocks.addProject.mockResolvedValue({ id: "project-1" });
  mocks.initProjectGit.mockResolvedValue({ id: "project-1" });
  mocks.disableNonGitWarning.mockResolvedValue(undefined);
  mocks.reload.mockResolvedValue(undefined);
  mocks.selectProject.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function pickFolder() {
  render(<CreateProjectDialog open onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
}

describe("CreateProjectDialog", () => {
  it("adds a git repository straight away", async () => {
    mocks.projectDirectoryIsGit.mockResolvedValue(true);
    await pickFolder();

    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledWith("project-1"));
    expect(mocks.addProject).toHaveBeenCalledWith("/home/user/notes", { allowNonGit: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("warns about a plain folder with four ways forward", async () => {
    await pickFolder();

    expect(await screen.findByText("“notes” is not a git repository")).toBeTruthy();
    for (const name of [
      "Initialize git repository",
      "Open another project",
      "Continue without git",
      "Don’t show again",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(mocks.addProject).not.toHaveBeenCalled();
  });

  it("adds the plain folder when the user continues", async () => {
    await pickFolder();
    fireEvent.click(await screen.findByRole("button", { name: "Continue without git" }));

    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledWith("project-1"));
    expect(mocks.addProject).toHaveBeenCalledWith("/home/user/notes", { allowNonGit: true });
    expect(mocks.initProjectGit).not.toHaveBeenCalled();
    expect(mocks.disableNonGitWarning).not.toHaveBeenCalled();
  });

  it("initializes git for the picked folder", async () => {
    await pickFolder();
    fireEvent.click(await screen.findByRole("button", { name: "Initialize git repository" }));

    await waitFor(() => expect(mocks.initProjectGit).toHaveBeenCalledWith("project-1"));
    expect(mocks.selectProject).toHaveBeenCalledWith("project-1");
  });

  it("persists don't-show-again and adds the folder", async () => {
    await pickFolder();
    fireEvent.click(await screen.findByRole("button", { name: "Don’t show again" }));

    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledWith("project-1"));
    expect(mocks.disableNonGitWarning).toHaveBeenCalledOnce();
  });

  it("picks again when the user meant another project", async () => {
    await pickFolder();
    const another = await screen.findByRole("button", { name: "Open another project" });
    mocks.pickDirectory.mockResolvedValue("/home/user/repo");
    mocks.projectDirectoryIsGit.mockResolvedValue(true);
    fireEvent.click(another);

    await waitFor(() =>
      expect(mocks.addProject).toHaveBeenCalledWith("/home/user/repo", { allowNonGit: true }),
    );
  });

  it("skips the warning once it is turned off", async () => {
    mocks.nonGitWarningEnabled.mockResolvedValue(false);
    await pickFolder();

    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledWith("project-1"));
    expect(screen.queryByText("“notes” is not a git repository")).toBeNull();
  });
});
