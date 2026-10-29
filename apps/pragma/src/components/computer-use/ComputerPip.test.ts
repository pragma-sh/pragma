import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerScreenshot, ComputerSession } from "@pragma-sh/constants";
import { TooltipProvider } from "@/components/ui/tooltip";
import { computerRpc, streamComputerFrames } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  computerRpc: vi.fn().mockResolvedValue(undefined),
  streamComputerFrames: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/state/computer-use-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/computer-use-store")>()),
  useComputerUse: () => ({ snapshot: null, cursors: {} }),
}));

import {
  ComputerPip,
  clampPosition,
  containedRect,
  cursorInFrame,
} from "@/components/computer-use/ComputerPip";

afterEach(() => vi.useRealTimers());

describe("clampPosition", () => {
  const size = { width: 320, height: 236 };
  const bounds = { width: 1200, height: 800 };

  it("keeps the panel inside the window", () => {
    expect(clampPosition({ x: -50, y: -50 }, size, bounds)).toEqual({ x: 16, y: 16 });
    expect(clampPosition({ x: 5000, y: 5000 }, size, bounds)).toEqual({ x: 864, y: 548 });
    expect(clampPosition({ x: 100, y: 200 }, size, bounds)).toEqual({ x: 100, y: 200 });
  });

  it("pins to the margin when the window is smaller than the panel", () => {
    expect(clampPosition({ x: 100, y: 100 }, size, { width: 200, height: 100 })).toEqual({
      x: 16,
      y: 16,
    });
  });
});

describe("cursorInFrame", () => {
  const frame = { origin: { x: 100, y: 50 }, scale: 2, width: 400, height: 200 };

  it("maps a screen point to percentages of the frame", () => {
    expect(cursorInFrame({ point: { x: 200, y: 100 } }, frame)).toEqual({ left: 50, top: 50 });
  });

  it("returns null for a cursor outside the frame", () => {
    expect(cursorInFrame({ point: { x: 10, y: 10 } }, frame)).toBeNull();
    expect(cursorInFrame({ point: { x: 200, y: 100 } }, { ...frame, width: 0 })).toBeNull();
  });
});

describe("containedRect", () => {
  it("letterboxes a wide image above and below", () => {
    expect(containedRect({ width: 400, height: 100 }, { width: 200, height: 200 })).toEqual({
      left: 0,
      top: 75,
      width: 200,
      height: 50,
    });
  });

  it("pillarboxes a tall image at the sides", () => {
    expect(containedRect({ width: 100, height: 400 }, { width: 200, height: 200 })).toEqual({
      left: 75,
      top: 0,
      width: 50,
      height: 200,
    });
  });

  it("has no box for an empty image or panel", () => {
    expect(containedRect({ width: 0, height: 100 }, { width: 200, height: 200 })).toBeNull();
    expect(containedRect({ width: 100, height: 100 }, { width: 0, height: 200 })).toBeNull();
  });
});

const session: ComputerSession = {
  id: "cs_1",
  owner: { kind: "agentTab", tabId: "t1", label: "Agent" },
  leases: [{ appKey: "com.apple.safari", appName: "Safari", acquiredAt: 1 }],
  startedAt: 1,
  lastActionAt: 1,
  actionCount: 0,
  paused: false,
};

describe("Focus app", () => {
  it("focuses the selected session through the host control", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ComputerPip, {
          sessions: [
            session,
            {
              ...session,
              id: "cs_2",
              owner: { kind: "agentTab", tabId: "t2", label: "Other agent" },
            },
          ],
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Other agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus app" }));
    expect(computerRpc).toHaveBeenCalledWith({ op: "focusSession", session: "cs_2" });
  });

  it("disables focusing until the session controls an app", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ComputerPip, { sessions: [{ ...session, leases: [] }] }),
      ),
    );
    expect(screen.getByRole("button", { name: "Focus app" })).toBeDisabled();
  });
});

/** Makes the next preview stream report one capture failure. */
const failWith = (message: string) =>
  vi
    .mocked(streamComputerFrames)
    .mockImplementationOnce(async (_session, _width, _onFrame, onFailure) => {
      onFailure?.(message);
      return () => {};
    });

describe("preview placeholder", () => {
  it("offers the Screen Recording prompt when captures fail without the grant", async () => {
    failWith("the computer-use helper does not have the screenRecording permission");
    vi.mocked(computerRpc).mockResolvedValueOnce({
      platform: "macos",
      accessibility: "granted",
      screenRecording: "denied",
      supported: true,
    });
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Allow Screen Recording" }));
    expect(computerRpc).toHaveBeenLastCalledWith({
      op: "permissions",
      request: true,
      permission: "screenRecording",
    });
  });

  it("keeps waiting, with the reason, when the grant is not the problem", async () => {
    failWith("that session is not controlling an app");
    vi.mocked(computerRpc).mockResolvedValueOnce({
      platform: "macos",
      accessibility: "granted",
      screenRecording: "granted",
      supported: true,
    });
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    expect(await screen.findByText("that session is not controlling an app")).toBeInTheDocument();
    expect(screen.queryByTestId("computer-pip-screen-recording")).toBeNull();
  });

  it("offers recovery from the capture error even if checking permissions fails", async () => {
    failWith("Screen Recording permission is unavailable");
    vi.mocked(computerRpc).mockRejectedValueOnce(new Error("helper restarting"));
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    expect(await screen.findByRole("button", { name: "Allow Screen Recording" })).toBeEnabled();
  });

  it("recognizes a permission failure after an earlier unrelated capture error", async () => {
    failWith("that session is not controlling an app");
    vi.mocked(computerRpc).mockResolvedValueOnce({
      platform: "macos",
      accessibility: "granted",
      screenRecording: "granted",
      supported: true,
    });
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    await screen.findByText("that session is not controlling an app");
    await act(async () => {
      vi.mocked(streamComputerFrames).mock.calls.at(-1)![3]?.(
        "the helper does not have the screenRecording permission",
      );
    });
    expect(
      await screen.findByRole("button", { name: "Allow Screen Recording" }),
    ).toBeInTheDocument();
  });

  it("rechecks a stale granted result while capture failures continue", async () => {
    vi.useFakeTimers();
    failWith("Could not capture the window");
    vi.mocked(computerRpc).mockResolvedValue({
      platform: "macos",
      accessibility: "granted",
      screenRecording: "granted",
      supported: true,
    });
    await act(async () => {
      render(
        createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
      );
    });
    expect(screen.queryByRole("button", { name: "Allow Screen Recording" })).toBeNull();
    vi.mocked(computerRpc).mockResolvedValue({
      platform: "macos",
      accessibility: "granted",
      screenRecording: "denied",
      supported: true,
    });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Allow Screen Recording" })).toBeInTheDocument();
  });

  it("offers recovery when preview startup itself rejects for missing permission", async () => {
    vi.mocked(streamComputerFrames).mockRejectedValueOnce(
      new Error("Screen Recording access denied"),
    );
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    expect(
      await screen.findByRole("button", { name: "Allow Screen Recording" }),
    ).toBeInTheDocument();
  });

  it("does not offer macOS permission recovery for Windows notApplicable grants", async () => {
    failWith("target window is unavailable");
    vi.mocked(computerRpc).mockResolvedValueOnce({
      platform: "windows",
      accessibility: "notApplicable",
      screenRecording: "notApplicable",
      supported: true,
    });
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    await screen.findByText("target window is unavailable");
    expect(screen.queryByRole("button", { name: "Allow Screen Recording" })).toBeNull();
  });

  it("replaces a stale frame with permission recovery and restores the next good frame", async () => {
    const frame: ComputerScreenshot = {
      id: "frame-1",
      path: "/tmp/frame.jpg",
      width: 2,
      height: 2,
      bytes: 1,
      origin: { x: 0, y: 0 },
      scale: 1,
      format: "jpeg",
      base64: "",
    };
    vi.mocked(streamComputerFrames).mockImplementationOnce(async (_session, _width, onFrame) => {
      onFrame(frame);
      return () => {};
    });
    render(
      createElement(TooltipProvider, null, createElement(ComputerPip, { sessions: [session] })),
    );
    expect(await screen.findByRole("img", { name: "What the agent sees" })).toBeInTheDocument();
    const [, , onFrame, onFailure] = vi.mocked(streamComputerFrames).mock.calls.at(-1)!;
    await act(async () => onFailure?.("Screen Recording permission missing"));
    expect(screen.getByRole("button", { name: "Allow Screen Recording" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    await act(async () => onFrame(frame));
    expect(screen.getByRole("img", { name: "What the agent sees" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow Screen Recording" })).toBeNull();
  });
});
