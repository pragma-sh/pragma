import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateSuccessDialog } from "@/components/updates/UpdateSuccessDialog";

const github = vi.hoisted(() => ({ authenticated: false, loading: false }));
const isRepoStarred = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const starRepo = vi.hoisted(() => vi.fn<() => Promise<void>>());
const browserOpenExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/state/github-context", () => ({ useGitHub: () => github }));
vi.mock("@/lib/github", () => ({ isRepoStarred, starRepo }));
vi.mock("@/lib/tauri", () => ({ browserOpenExternal }));

function renderDialog() {
  return render(<UpdateSuccessDialog version="1.4.0" onClose={() => undefined} />);
}

describe("UpdateSuccessDialog", () => {
  beforeEach(() => {
    github.authenticated = false;
    isRepoStarred.mockReset();
    starRepo.mockReset();
    browserOpenExternal.mockClear();
  });

  it("confirms the version and offers share links", () => {
    renderDialog();
    expect(screen.getByText("You're now running Pragma 1.4.0.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hacker News" })).toBeTruthy();
  });

  it("links to the repository when signed out", async () => {
    renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Star on GitHub" }));
    expect(browserOpenExternal).toHaveBeenCalledWith("https://github.com/pragma-sh/pragma");
    expect(isRepoStarred).not.toHaveBeenCalled();
  });

  it("hides the star row when the repository is already starred", async () => {
    github.authenticated = true;
    isRepoStarred.mockResolvedValue(true);
    renderDialog();
    await waitFor(() => expect(isRepoStarred).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Star on GitHub" })).toBeNull();
  });

  it("stars when signed in, then thanks the user in its place", async () => {
    github.authenticated = true;
    isRepoStarred.mockResolvedValue(false);
    starRepo.mockResolvedValue();
    renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Star on GitHub" }));
    expect(starRepo).toHaveBeenCalled();
    expect(await screen.findByText("Thanks for starring Pragma on GitHub!")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Star on GitHub" })).toBeNull();
  });
});
