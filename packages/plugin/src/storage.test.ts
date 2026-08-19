import { describe, expect, it } from "vitest";

import * as storage from "./storage";

describe("plugin storage API", () => {
  it("does not expose caller-selected storage namespaces", () => {
    expect(storage).not.toHaveProperty("storageFor");
    expect(storage).not.toHaveProperty("getStoredState");
    expect(storage).not.toHaveProperty("setStoredState");
    expect(storage).not.toHaveProperty("deleteStoredState");
  });
});
