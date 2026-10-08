import { describe, expect, it } from "vitest";

import { MIN_COLUMN_WIDTH, resizeColumn } from "./fanout";

describe("comparison grid", () => {
  it("resizes one shared column model and clamps to a minimum", () => {
    expect(resizeColumn([400, 400], 0, 60)).toEqual([460, 400]);
    expect(resizeColumn([400, 400], 1, -1000)).toEqual([400, MIN_COLUMN_WIDTH]);
  });
});
