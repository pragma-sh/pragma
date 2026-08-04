import { describe, expect, it } from "vitest";

import { pushRoute } from "./push-route";

describe("pushRoute", () => {
  it("opens the reporting agent's chat tab", () => {
    expect(pushRoute({ tabId: "tab-1", worktreeId: "worktree-1", agent: "claude" })).toEqual({
      pathname: "/chat/[tabId]",
      params: { tabId: "tab-1", worktreeId: "worktree-1", agent: "claude" },
    });
  });

  it("keeps optional routing params off when the host omitted them", () => {
    expect(pushRoute({ tabId: "tab-1" })).toEqual({
      pathname: "/chat/[tabId]",
      params: { tabId: "tab-1" },
    });
  });

  it("routes nowhere without a tab", () => {
    expect(pushRoute(null)).toBeNull();
    expect(pushRoute(undefined)).toBeNull();
    expect(pushRoute({})).toBeNull();
    expect(pushRoute({ tabId: "  " })).toBeNull();
    expect(pushRoute({ tabId: 7 })).toBeNull();
  });
});
