import { describe, expect, test } from "bun:test";

import { shouldDeploy } from "./deploy";

describe("shouldDeploy", () => {
  test("builds every preview deployment", () => {
    expect(shouldDeploy({ env: "preview", commitMessage: "docs: fix a typo" })).toBe(true);
    expect(shouldDeploy({ env: "development", commitMessage: "docs: fix a typo" })).toBe(true);
  });

  test("builds production for a squashed release commit", () => {
    expect(shouldDeploy({ env: "production", commitMessage: "chore(main): release" })).toBe(true);
    expect(shouldDeploy({ env: "production", commitMessage: "chore: release main" })).toBe(true);
  });

  test("builds production for a release merge commit", () => {
    expect(
      shouldDeploy({
        env: "production",
        commitMessage:
          "Merge pull request #142 from pragma-sh/release-please--branches--main\n\nchore(main): release",
      }),
    ).toBe(true);
  });

  test("skips production for an ordinary merge to main", () => {
    expect(
      shouldDeploy({
        env: "production",
        commitMessage: "Merge pull request #128 from pragma-sh/linux-desktop-fixes",
      }),
    ).toBe(false);
    expect(shouldDeploy({ env: "production", commitMessage: "docs: fix a typo" })).toBe(false);
  });

  test("builds when provenance is unreadable rather than skipping silently", () => {
    expect(shouldDeploy({ env: "production", commitMessage: undefined })).toBe(true);
  });
});
