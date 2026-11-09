import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputerApproval, ComputerPermissions } from "@pragma-sh/constants";

import { ComputerApprovalDialog } from "@/components/computer-use/ComputerApprovalDialog";
import { computerRpc } from "@/lib/tauri";
import { answerApproval, refreshComputerUse } from "@/state/computer-use-store";

vi.mock("@/lib/tauri", () => ({ computerRpc: vi.fn() }));
vi.mock("@/state/computer-use-store", () => ({
  answerApproval: vi.fn().mockResolvedValue(undefined),
  refreshComputerUse: vi.fn().mockResolvedValue(undefined),
}));

const approval: ComputerApproval = {
  id: "approval-1",
  caller: { kind: "agentTab", tabId: "tab-1", label: "Agent" },
  op: "apps",
  reason: "Agent wants to use your computer",
  sensitive: false,
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

const denied: ComputerPermissions = {
  platform: "macos",
  supported: true,
  accessibility: "denied",
  screenRecording: "denied",
};
const granted: ComputerPermissions = {
  ...denied,
  accessibility: "granted",
  screenRecording: "granted",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computerRpc).mockReset().mockResolvedValue(denied);
});

describe("computer-use permission setup", () => {
  it("requests each native grant separately, then waits for Pragma approval", async () => {
    render(<ComputerApprovalDialog approvals={[approval]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow Accessibility" }));
    expect(computerRpc).toHaveBeenLastCalledWith({
      op: "permissions",
      request: true,
      permission: "accessibility",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Allow Screen Recording" })).toBeEnabled(),
    );
    vi.mocked(computerRpc).mockResolvedValue(granted);
    fireEvent.click(screen.getByRole("button", { name: "Allow Screen Recording" }));
    expect(computerRpc).toHaveBeenLastCalledWith({
      op: "permissions",
      request: true,
      permission: "screenRecording",
    });
    expect(await screen.findByRole("heading", { name: approval.reason })).toBeInTheDocument();
    expect(answerApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(answerApproval).toHaveBeenCalledWith(approval, "session");
  });

  it("rechecks on focus and only advances once both grants are enabled", async () => {
    render(<ComputerApprovalDialog approvals={[approval]} />);
    await screen.findByRole("button", { name: "Allow Accessibility" });
    vi.mocked(computerRpc).mockResolvedValue({ ...denied, accessibility: "granted" });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("button", { name: "Accessibility enabled" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
    vi.mocked(computerRpc).mockResolvedValue(granted);
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("button", { name: "Allow for this session" })).toBeEnabled();
    expect(computerRpc).toHaveBeenLastCalledWith({ op: "permissions" });
  });

  it("polls missing grants and stops when the host withdraws the request", async () => {
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    const { rerender } = render(<ComputerApprovalDialog approvals={[approval]} />);
    await screen.findByRole("button", { name: "Allow Accessibility" });
    vi.mocked(computerRpc).mockResolvedValue(granted);
    const [poll] = interval.mock.calls.at(-1)!;
    await act(async () => {
      if (typeof poll === "function") await poll();
    });
    expect(screen.getByRole("button", { name: "Allow for this session" })).toBeInTheDocument();
    expect(clear).toHaveBeenCalled();
    rerender(<ComputerApprovalDialog approvals={[]} />);
    vi.mocked(computerRpc).mockClear();
    fireEvent(window, new Event("focus"));
    expect(computerRpc).not.toHaveBeenCalled();
    interval.mockRestore();
    clear.mockRestore();
  });

  it("can deny during setup without requesting an OS grant", async () => {
    render(<ComputerApprovalDialog approvals={[approval]} />);
    await screen.findByRole("button", { name: "Allow Accessibility" });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(answerApproval).toHaveBeenCalledWith(approval, "deny");
    expect(computerRpc).toHaveBeenCalledExactlyOnceWith({ op: "permissions" });
  });

  it.each([
    granted,
    {
      ...granted,
      platform: "windows",
      accessibility: "notApplicable",
      screenRecording: "notApplicable",
    },
  ])("skips setup when native grants are already satisfied ($platform)", async (permissions) => {
    vi.mocked(computerRpc).mockResolvedValue(permissions);
    render(<ComputerApprovalDialog approvals={[{ ...approval, sensitive: true }]} />);
    expect(await screen.findByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow Accessibility" })).toBeNull();
  });

  it("shows permission errors without allowing the agent to bypass setup", async () => {
    vi.mocked(computerRpc).mockRejectedValue(new Error("helper unavailable"));
    render(<ComputerApprovalDialog approvals={[approval]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("helper unavailable");
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    vi.mocked(computerRpc).mockResolvedValue(granted);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Always allow" })).toBeEnabled();
    expect(refreshComputerUse).not.toHaveBeenCalled();
  });
});
