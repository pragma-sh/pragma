import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEscapeToClose } from "./use-escape-to-close";

function dispatchKeydown(key: string, cancelable = true): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable, key });
  window.dispatchEvent(event);
  return event;
}

describe("useEscapeToClose", () => {
  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));

    dispatchKeydown("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when a non-Escape key is pressed", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));

    dispatchKeydown("Enter");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose when open is false", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(false, onClose));

    dispatchKeydown("Escape");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls preventDefault on the Escape event", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));

    const event = dispatchKeydown("Escape");

    expect(event.defaultPrevented).toBe(true);
  });

  it("stops listening when open transitions to false", async () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useEscapeToClose(open, onClose),
      { initialProps: { open: true } },
    );

    rerender({ open: false });

    dispatchKeydown("Escape");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useEscapeToClose(true, onClose));

    unmount();
    dispatchKeydown("Escape");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call the stale onClose after it changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onClose }: { onClose: () => void }) => useEscapeToClose(true, onClose),
      { initialProps: { onClose: first } },
    );

    rerender({ onClose: second });
    dispatchKeydown("Escape");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
