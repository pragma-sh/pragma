import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "./encoding";

describe("encoding", () => {
  it("round trips base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
