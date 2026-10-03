import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAccountLogin } from "@/components/accounts/use-account-login";
import type { HarnessView } from "@/lib/accounts";
import type { ProjectAccounts } from "@/state/accounts-store";

vi.mock("@/lib/tauri", () => ({ browserOpenExternal: vi.fn() }));

const HARNESS = {
  agentId: "pragma.pi",
  source: { pluginId: "pragma.pi", providerId: "openai" },
} as unknown as HarnessView;

/** A promise plus the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

function storeWith(beginLogin: () => Promise<{ loginId: string }>) {
  const cancelLogin = vi.fn(() => Promise.resolve());
  const store = { api: { beginLogin, cancelLogin } } as unknown as ProjectAccounts;
  return { store, cancelLogin };
}

describe("useAccountLogin", () => {
  it("cancels a sign-in the host starts after the flow was cancelled", async () => {
    const pending = deferred<{ loginId: string }>();
    const { store, cancelLogin } = storeWith(() => pending.promise);
    const { result } = renderHook(() => useAccountLogin(store, false));

    let begun: Promise<void> = Promise.resolve();
    act(() => {
      begun = result.current.begin(HARNESS);
    });
    await act(() => result.current.cancel());
    expect(cancelLogin).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ loginId: "late" });
      await begun;
    });
    expect(cancelLogin).toHaveBeenCalledWith("late");
    expect(result.current.phase).toBe("idle");
  });

  it("waits on a sign-in that was not cancelled", async () => {
    const { store, cancelLogin } = storeWith(() => Promise.resolve({ loginId: "live" }));
    const { result } = renderHook(() => useAccountLogin(store, false));

    await act(() => result.current.begin(HARNESS));
    expect(result.current.phase).toBe("waiting");
    expect(cancelLogin).not.toHaveBeenCalled();
  });
});
