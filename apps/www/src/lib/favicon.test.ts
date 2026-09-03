import { describe, expect, it } from "bun:test";

import Icon, { contentType, size } from "../app/icon";

describe("site favicon", () => {
  it("serves compact theme-aware SVG from the brand package", async () => {
    const response = Icon();
    const svg = await response.text();

    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(size).toEqual({ width: 32, height: 32 });
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).toContain('rx="224"');
    expect(svg).not.toContain("<mask");
  });
});
