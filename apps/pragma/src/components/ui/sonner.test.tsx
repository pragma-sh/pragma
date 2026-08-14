import { act, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_MOUNTED_TOASTS, Toaster } from "./sonner";

const mountedToasts = () => document.querySelectorAll("[data-sonner-toast]").length;

afterEach(() => {
  act(() => {
    toast.dismiss();
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
