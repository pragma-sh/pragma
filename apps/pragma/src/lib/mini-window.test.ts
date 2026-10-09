import { constants } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import { isMiniSessionId, isMiniWindowLabel, newMiniSessionId } from "@/lib/mini-window";

describe("mini window ids", () => {
  it("recognises mini window labels", () => {
    expect(isMiniWindowLabel(`${constants.miniWindow.labelPrefix}abc`)).toBe(true);
    expect(isMiniWindowLabel("main")).toBe(false);
  });

  it("mints unique session ids the main window can recognise", () => {
    const first = newMiniSessionId();
    expect(isMiniSessionId(first)).toBe(true);
    expect(first).not.toBe(newMiniSessionId());
    expect(isMiniSessionId(crypto.randomUUID())).toBe(false);
  });
});
