import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants } from "@pragma-sh/constants";

const { invoke, channels } = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as { onmessage: (value: unknown) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
    constructor() {
      channels.push(this);
    }
  },
}));
import { streamComputerFrames } from "./tauri";

const granted = {
  platform: "macos",
  accessibility: "granted",
  screenRecording: "granted",
  supported: true,
};

describe("computer preview channel", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    channels.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it("delivers frames and releases the exact stream while suppressing late delivery", async () => {
    invoke
      .mockResolvedValueOnce(granted)
      .mockResolvedValueOnce("preview-1")
      .mockResolvedValueOnce(undefined);
    const onFrame = vi.fn();
    const release = await streamComputerFrames("session-1", 480, onFrame);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "computer_start_preview",
      expect.objectContaining({ session: "session-1", maxWidth: 480 }),
    );
    channels[0]!.onmessage({ id: "frame-1" });
    expect(onFrame).toHaveBeenCalledOnce();
    release();
    channels[0]!.onmessage({ id: "late-frame" });
    expect(onFrame).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith("computer_stop_preview", { streamId: "preview-1" });
  });

  it("reports capture failures on their own channel until released", async () => {
    invoke.mockResolvedValueOnce(granted).mockResolvedValueOnce("preview-1");
    const onFailure = vi.fn();
    const release = await streamComputerFrames("session-1", 480, vi.fn(), onFailure);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "computer_start_preview",
      expect.objectContaining({ failures: channels[1] }),
    );
    channels[1]!.onmessage("no screen recording");
    expect(onFailure).toHaveBeenCalledWith("no screen recording");
    release();
    channels[1]!.onmessage("late failure");
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("refreshes stale macOS permissions before starting the preview", async () => {
    invoke
      .mockResolvedValueOnce({ ...granted, screenRecording: "denied" })
      .mockResolvedValueOnce(granted)
      .mockResolvedValueOnce("preview-1");
    const release = await streamComputerFrames("session-1", 480, vi.fn());
    for (const call of [1, 2]) {
      expect(invoke).toHaveBeenNthCalledWith(call, "computer_rpc", {
        payload: { op: "permissions" },
      });
    }
    expect(invoke).toHaveBeenNthCalledWith(3, "computer_start_preview", expect.anything());
    release();
  });

  it("starts capture even if a permission status check fails", async () => {
    invoke.mockRejectedValueOnce("host starting").mockResolvedValueOnce("preview-1");
    const release = await streamComputerFrames("session-1", 480, vi.fn());
    expect(invoke).toHaveBeenNthCalledWith(2, "computer_start_preview", expect.anything());
    release();
  });

  it("starts capturing immediately when the desktop predates the streaming command", async () => {
    vi.useFakeTimers();
    invoke
      .mockResolvedValueOnce(granted)
      .mockRejectedValueOnce("Command computer_start_preview not found")
      .mockResolvedValueOnce({ id: "first-frame" })
      .mockResolvedValueOnce({ id: "next-frame" });
    const onFrame = vi.fn();
    const release = await streamComputerFrames("session-1", 480, onFrame);
    expect(invoke).toHaveBeenLastCalledWith("computer_rpc", {
      payload: { op: "frame", session: "session-1", maxWidth: 480 },
    });
    expect(onFrame).toHaveBeenCalledWith({ id: "first-frame" });
    await vi.advanceTimersByTimeAsync(constants.computer.pipFrameIntervalMs);
    expect(onFrame).toHaveBeenLastCalledWith({ id: "next-frame" });
    release();
    await vi.advanceTimersByTimeAsync(constants.computer.pipFrameIntervalMs * 2);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("recovers when launch has not acquired an app yet without overlapping captures", async () => {
    vi.useFakeTimers();
    let finishCapture!: (value: unknown) => void;
    invoke
      .mockResolvedValueOnce(granted)
      .mockRejectedValueOnce("Command computer_start_preview not found")
      .mockRejectedValueOnce("that session is not controlling an app")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      );
    const onFrame = vi.fn();
    const release = await streamComputerFrames("session-1", 480, onFrame);
    await vi.advanceTimersByTimeAsync(constants.computer.pipFrameIntervalMs * 3);
    expect(invoke).toHaveBeenCalledTimes(4);
    release();
    finishCapture({ id: "late-frame" });
    await vi.advanceTimersByTimeAsync(constants.computer.pipFrameIntervalMs * 2);
    expect(onFrame).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("preserves startup errors other than a missing command", async () => {
    invoke.mockResolvedValueOnce(granted).mockRejectedValueOnce("preview stream unavailable");
    await expect(streamComputerFrames("session-1", 480, vi.fn())).rejects.toBe(
      "preview stream unavailable",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
