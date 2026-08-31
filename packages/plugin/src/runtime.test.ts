import { afterEach, describe, expect, it, vi } from "vitest";

import type { PragmaBridge } from "./bridge";
import { getTheme, listSessions, subscribeEvent, subscribeTheme } from "./runtime";

function clearBridge(): void {
  globalThis.__PRAGMA__ = undefined;
}

describe("imperative plugin runtime", () => {
  afterEach(clearBridge);

  it("gets and subscribes to theme changes", () => {
    let theme: "light" | "dark" = "dark";
    let hostListener: () => void = vi.fn();
    const unsubscribe = vi.fn();
    globalThis.__PRAGMA__ = {
      actions: {
        theme: {
          get: () => theme,
          subscribe: (listener: () => void) => {
            hostListener = listener;
            return unsubscribe;
          },
        },
      },
    } as unknown as PragmaBridge;
    const listener = vi.fn();

    expect(getTheme()).toBe("dark");
    const stop = subscribeTheme(listener);
    theme = "light";
    hostListener();
    stop();

    expect(listener).toHaveBeenCalledWith("light");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("subscribes to events and lists sessions", async () => {
    let eventHandler: (payload: unknown) => void = vi.fn();
    const unsubscribe = vi.fn();
    const sessions = [{ id: "session-1", cwd: "/repo" }];
    globalThis.__PRAGMA__ = {
      actions: {
        events: {
          subscribe: (_eventName: string, handler: (payload: unknown) => void) => {
            eventHandler = handler;
            return unsubscribe;
          },
        },
        sessions: { list: vi.fn().mockResolvedValue(sessions) },
      },
    } as unknown as PragmaBridge;
    const handler = vi.fn();

    const stop = subscribeEvent<{ status: string }>("agent.report", handler);
    eventHandler({ status: "done" });
    stop();

    expect(handler).toHaveBeenCalledWith({ status: "done" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(listSessions()).resolves.toEqual(sessions);
  });
});
