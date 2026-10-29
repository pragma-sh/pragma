import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRestoreSnapshot } from "@/lib/tauri";

const read = vi.fn();
const stop = vi.fn();
let reset: () => void;
vi.mock("@/lib/tauri", () => ({
  sessionRestoreStatus: () => read(),
  onAgentStatusReset: (handler: () => void) => {
    reset = handler;
    return Promise.resolve(stop);
  },
}));

import { SessionRestoreDialog } from "./SessionRestoreDialog";

function report(complete = false, error: string | null = null): SessionRestoreSnapshot[] {
  return [
    {
      bootId: "boot-1",
      startupComplete: complete,
      sessions: [{ tabId: "tab-1", title: "Fix auth", complete, error }],
    },
  ];
}

describe("SessionRestoreDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    read.mockResolvedValue(report());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not open for ordinary reattachment or a boot without interrupted sessions", async () => {
    read.mockResolvedValue([{ bootId: "boot-1", startupComplete: true, sessions: [] }]);
    render(<SessionRestoreDialog />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows progress and then the host's completion without starting any sessions", async () => {
    render(<SessionRestoreDialog />);
    await screen.findByRole("heading", { name: "Restoring sessions" });
    expect(screen.getByText("Fix auth")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 of 1 processed");
    read.mockResolvedValue(report(true));
    act(() => reset());
    await screen.findByRole("heading", { name: "Session restore complete" });
    expect(screen.getByText("Conversation restored")).toBeInTheDocument();
  });

  it("keeps failures visible with the actual error", async () => {
    read.mockResolvedValue(report(true, "Resume callback is unavailable"));
    render(<SessionRestoreDialog />);
    await screen.findByText("Resume callback is unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("1 could not be restored");
    expect(screen.getByText(/Failed restores never start a new conversation/)).toBeInTheDocument();
  });

  it("dismisses without cancelling recovery and remembers that boot across a remount", async () => {
    const view = render(<SessionRestoreDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue in background" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    view.unmount();
    expect(stop).toHaveBeenCalled();
    render(<SessionRestoreDialog />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    read.mockResolvedValue([{ ...report()[0]!, bootId: "boot-2" }]);
    act(() => reset());
    await screen.findByRole("heading", { name: "Restoring sessions" });
  });

  it("replaces a previous boot's in-flight report after another crash", async () => {
    render(<SessionRestoreDialog />);
    await screen.findByRole("heading", { name: "Restoring sessions" });
    read.mockResolvedValue([{ ...report(true)[0]!, bootId: "boot-2" }]);
    act(() => reset());
    await screen.findByRole("heading", { name: "Session restore complete" });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 processed");
  });
});
