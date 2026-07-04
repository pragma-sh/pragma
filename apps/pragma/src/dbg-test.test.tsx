import { describe, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  console.log("[dbg] @tauri-apps/api/core factory invoked");
  return {
    Channel: class MockChannel<T> {
      onmessage?: (message: T) => void;
    },
    invoke: () => Promise.resolve("MOCKED"),
  };
});

describe("mock test", () => {
  it("checks mock", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("test");
    console.log("[dbg] result =", result);
  });
});
