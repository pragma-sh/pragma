import { describe, expect, it } from "vitest";

import { DEFAULT_DEV_PORT, findAvailableDevPort, resolveDevPort } from "./dev-port";

describe("dev port", () => {
  it("uses the default when no override is present", () => {
    expect(resolveDevPort(undefined)).toBe(DEFAULT_DEV_PORT);
  });

  it("validates an explicit override", () => {
    expect(resolveDevPort("2468")).toBe(2468);
    expect(() => resolveDevPort("not-a-port")).toThrow("PRAGMA_DEV_PORT");
    expect(() => resolveDevPort("65535")).toThrow("PRAGMA_DEV_PORT");
  });

  it("skips occupied Vite or HMR port pairs", async () => {
    const occupied = new Set([1420, 1423]);
    const port = await findAvailableDevPort(async (candidate) => !occupied.has(candidate));
    expect(port).toBe(1424);
  });
});
