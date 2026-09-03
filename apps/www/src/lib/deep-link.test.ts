import { describe, expect, it } from "bun:test";

import { deepLinkQuery, pragmaDeepLinkUrl, webDeepLinkUrl } from "./deep-link";

describe("deep-link forwarders", () => {
  it("builds pragma targets with and without a query", () => {
    expect(pragmaDeepLinkUrl("open", "")).toBe("pragma://open");
    expect(pragmaDeepLinkUrl("open", "worktree=wt-1")).toBe("pragma://open?worktree=wt-1");
  });

  it("builds same-origin forwarder routes for gallery links", () => {
    expect(webDeepLinkUrl("open", {})).toBe("/open");
    expect(webDeepLinkUrl("install-plugin", { package: "@pragma-sh/pi-plugin" })).toBe(
      "/install-plugin?package=%40pragma-sh%2Fpi-plugin",
    );
  });

  it("flattens search params the way the desktop parser reads them", () => {
    expect(
      deepLinkQuery({
        worktree: "wt-1",
        repeated: ["first", "second"],
        empty: "",
        dropped: undefined,
      }),
    ).toBe("worktree=wt-1&repeated=second");
  });
});
