import { describe, expect, it } from "vitest";

import { baseBranchChoices } from "./base-branches";

describe("baseBranchChoices", () => {
  it("sorts and de-duplicates branches while excluding the head", () => {
    const branches = {
      branches: ["release", "feature", "main", "release"],
      defaultBranch: "main",
      headBranch: "feature",
    };

    expect(baseBranchChoices(branches)).toEqual(["main", "release"]);
    expect(branches.branches).toEqual(["release", "feature", "main", "release"]);
  });

  it("offers a missing default branch", () => {
    expect(
      baseBranchChoices({ branches: ["release"], defaultBranch: "main", headBranch: "feature" }),
    ).toEqual(["main", "release"]);
  });

  it("returns no choices while branches are unavailable", () => {
    expect(baseBranchChoices(null)).toEqual([]);
  });
});
