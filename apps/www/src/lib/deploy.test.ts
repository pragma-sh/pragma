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

  test("skips production when only the body mentions a release branch", () => {
    expect(
      shouldDeploy({
        env: "production",
        commitMessage:
          "fix(www): correct the deploy gate\n\nReverts release-please--branches--main, which deployed by mistake.",
      }),
    ).toBe(false);
    expect(
      shouldDeploy({
        env: "production",
        commitMessage: "Merge pull request #131 from pragma-sh/docs-release-please--branches--main",
      }),
    ).toBe(false);
  });

  test("builds production for a local merge of the release branch", () => {
    expect(
      shouldDeploy({
        env: "production",
        commitMessage: "Merge branch 'release-please--branches--main' into main",
      }),
    ).toBe(true);
    expect(
      shouldDeploy({
        env: "production",
        commitMessage: "Merge branch 'origin/release-please--branches--main'",
      }),
    ).toBe(true);
  });

  test("builds when provenance is unreadable rather than skipping silently", () => {
    expect(shouldDeploy({ env: "production", commitMessage: undefined })).toBe(true);
  });
});
