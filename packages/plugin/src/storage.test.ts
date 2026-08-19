import { afterEach, describe, expect, it, vi } from "vitest";

import type { PragmaBridge } from "./bridge";
import { deleteStoredState, getStoredState, setStoredState, storageFor } from "./storage";

function clearBridge(): void {
  globalThis.__PRAGMA__ = undefined;
}

describe("plugin storage", () => {
  afterEach(clearBridge);

  it("reads stored JSON and falls back when no value exists", async () => {
    const get = vi.fn().mockResolvedValueOnce('{"count":2}').mockResolvedValueOnce(null);
    globalThis.__PRAGMA__ = {
      actions: { storage: { get } },
    } as unknown as PragmaBridge;

    await expect(getStoredState("test.plugin", "settings", { count: 0 })).resolves.toEqual({
      count: 2,
    });
    await expect(getStoredState("test.plugin", "missing", 3)).resolves.toBe(3);
    expect(get).toHaveBeenNthCalledWith(1, "test.plugin", "settings");
    expect(get).toHaveBeenNthCalledWith(2, "test.plugin", "missing");
  });

  it("serializes values before writing them", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    globalThis.__PRAGMA__ = {
      actions: { storage: { set } },
    } as unknown as PragmaBridge;

    await setStoredState("test.plugin", "settings", { enabled: true });

    expect(set).toHaveBeenCalledWith("test.plugin", "settings", '{"enabled":true}');
  });

  it("rejects values JSON cannot serialize", async () => {
    const set = vi.fn();
    globalThis.__PRAGMA__ = {
      actions: { storage: { set } },
    } as unknown as PragmaBridge;

    await expect(setStoredState("test.plugin", "bad", undefined)).rejects.toThrow(
      "Plugin stored state must be JSON-serializable",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("deletes values and scopes a reusable storage client", async () => {
    const get = vi.fn().mockResolvedValue("4");
    const set = vi.fn().mockResolvedValue(undefined);
    const deleteValue = vi.fn().mockResolvedValue(undefined);
    globalThis.__PRAGMA__ = {
      actions: { storage: { get, set, delete: deleteValue } },
    } as unknown as PragmaBridge;
    const storage = storageFor("test.plugin");

    await expect(storage.get("count", 0)).resolves.toBe(4);
    await storage.set("count", 5);
    await storage.delete("count");
    await deleteStoredState("other.plugin", "count");

    expect(get).toHaveBeenCalledWith("test.plugin", "count");
    expect(set).toHaveBeenCalledWith("test.plugin", "count", "5");
    expect(deleteValue).toHaveBeenNthCalledWith(1, "test.plugin", "count");
    expect(deleteValue).toHaveBeenNthCalledWith(2, "other.plugin", "count");
  });
});
