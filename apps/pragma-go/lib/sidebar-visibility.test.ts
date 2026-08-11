import { describe, expect, it } from "vitest";

import { routeNeedsSidebar } from "./sidebar-visibility";

describe("routeNeedsSidebar", () => {
  it.each(["/chat/tab-1", "/scratchpad/pad-1"])(
    "shows worktree navigation beside %s",
    (pathname) => {
      expect(routeNeedsSidebar(pathname)).toBe(true);
    },
  );

  it.each(["/", "/project/project-1", "/worktree/worktree-1", "/inbox", "/inbox/item-1"])(
    "does not duplicate picker navigation on %s",
    (pathname) => {
      expect(routeNeedsSidebar(pathname)).toBe(false);
    },
  );
});
