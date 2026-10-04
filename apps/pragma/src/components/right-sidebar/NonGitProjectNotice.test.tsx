import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initProjectGit: vi.fn(() => Promise.resolve({ id: "project-1" })),
  reload: vi.fn(() => Promise.resolve()),
  refreshProject: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  initProjectGit: mocks.initProjectGit,
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ reload: mocks.reload, refreshProject: mocks.refreshProject }),
}));

import { CREATE_PROJECT_EVENT } from "@/lib/non-git-project";
import { NonGitProjectNotice } from "./NonGitProjectNotice";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NonGitProjectNotice", () => {
  it("initializes git and reloads the project in place", async () => {
    render(<NonGitProjectNotice feature="Changes" projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Initialize git repository" }));

    await waitFor(() => expect(mocks.refreshProject).toHaveBeenCalledWith("project-1"));
    expect(mocks.initProjectGit).toHaveBeenCalledWith("project-1");
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("opens the Add project dialog for another project", () => {
    const listener = vi.fn();
    window.addEventListener(CREATE_PROJECT_EVENT, listener);
    render(<NonGitProjectNotice feature="Pull requests" projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Open another project" }));

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(CREATE_PROJECT_EVENT, listener);
  });
});
