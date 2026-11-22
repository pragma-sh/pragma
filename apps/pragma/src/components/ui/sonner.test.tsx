import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_MOUNTED_TOASTS, Toaster } from "./sonner";
import { LONG_TOAST_ATTR, LONG_TOAST_CHARS, OPEN_TOAST_ATTR } from "./toast-overflow";

const mountedToasts = () => document.querySelectorAll("[data-sonner-toast]").length;

// Dismissing schedules sonner's own unmount timer, which calls `setState` once
// it fires. Wait for it while the Toaster is still mounted: a timer left
// pending outlives the file's jsdom environment and throws
// "window is not defined" as an unhandled error, failing the whole run.
afterEach(async () => {
  act(() => {
    toast.dismiss();
  });
  await waitFor(() => {
    expect(mountedToasts()).toBe(0);
  });
});

describe("Toaster", () => {
  it("keeps at most MAX_MOUNTED_TOASTS toasts in the DOM", async () => {
    render(<Toaster />);

    for (let index = 0; index < MAX_MOUNTED_TOASTS + 5; index += 1) {
      await act(async () => {
        toast(`toast ${index}`, { duration: Number.POSITIVE_INFINITY });
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(mountedToasts()).toBeLessThanOrEqual(MAX_MOUNTED_TOASTS);
    });
  });

  it("leaves toasts mounted below the cap", async () => {
    render(<Toaster />);

    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        toast(`toast ${index}`, { duration: Number.POSITIVE_INFINITY });
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(mountedToasts()).toBe(3);
    });
  });
});

const toastNode = () => document.querySelector<HTMLElement>("[data-sonner-toast]");

describe("long toasts", () => {
  it("moves the buttons below long text and leaves short toasts alone", async () => {
    render(<Toaster />);

    await act(async () => {
      toast.error("Short", { duration: Number.POSITIVE_INFINITY });
      await Promise.resolve();
    });
    await waitFor(() => expect(toastNode()).not.toBeNull());
    expect(toastNode()?.hasAttribute(LONG_TOAST_ATTR)).toBe(false);

    act(() => {
      toast.dismiss();
    });
    await waitFor(() => expect(mountedToasts()).toBe(0));
    await act(async () => {
      toast.error("Failed", {
        description: "x".repeat(LONG_TOAST_CHARS + 1),
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Retry", onClick: () => {} },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(toastNode()?.hasAttribute(LONG_TOAST_ATTR)).toBe(true));
  });

  it("offers Show more only when the clamp hides text, and toggles it", async () => {
    // jsdom has no layout: report the description as taller than its box.
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-description") ? 100 : 0;
      });
    render(<Toaster />);

    await act(async () => {
      toast("Failed", { description: "a\nb\nc\nd\ne", duration: Number.POSITIVE_INFINITY });
      await Promise.resolve();
    });
    const button = await screen.findByRole("button", { name: "Show more" });

    fireEvent.click(button);

    expect(toastNode()?.hasAttribute(OPEN_TOAST_ATTR)).toBe(true);
    expect(await screen.findByRole("button", { name: "Show less" })).toBeInTheDocument();
    scrollHeight.mockRestore();
  });
});
