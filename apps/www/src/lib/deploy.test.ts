import { describe, expect, test } from "bun:test";

import { DEPLOY_LABEL, fetchPrLabels, needsPrLabels, shouldDeploy } from "./deploy";

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

  test("builds production for a merge labelled for deploy", () => {
    const commitMessage = "docs(www): publish the storage manager post (#170)";
    expect(shouldDeploy({ env: "production", commitMessage, prLabels: [DEPLOY_LABEL] })).toBe(true);
    expect(shouldDeploy({ env: "production", commitMessage, prLabels: ["documentation"] })).toBe(
      false,
    );
    expect(shouldDeploy({ env: "production", commitMessage, prLabels: [] })).toBe(false);
  });
});

describe("needsPrLabels", () => {
  test("only asks GitHub when the labels can change the answer", () => {
    expect(needsPrLabels({ env: "production", commitMessage: "docs: fix a typo" })).toBe(true);
    expect(needsPrLabels({ env: "preview", commitMessage: "docs: fix a typo" })).toBe(false);
    expect(needsPrLabels({ env: "production", commitMessage: "chore(main): release" })).toBe(false);
    expect(needsPrLabels({ env: "production", commitMessage: undefined })).toBe(false);
  });
});

/** A fetch stub answering every request with `body`. */
const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("fetchPrLabels", () => {
  const sha = "abc123";
  const pull = (overrides: Record<string, unknown>) => ({
    merged_at: "2026-09-27T00:00:00Z",
    merge_commit_sha: sha,
    labels: [{ name: DEPLOY_LABEL }],
    ...overrides,
  });

  test("returns the labels of the pull request that merged the commit", async () => {
    expect(await fetchPrLabels(sha, respond([pull({})]))).toEqual([DEPLOY_LABEL]);
  });

  test("ignores open pull requests and ones merged as a different commit", async () => {
    const pulls = [pull({ merged_at: null }), pull({ merge_commit_sha: "def456" })];
    expect(await fetchPrLabels(sha, respond(pulls))).toEqual([]);
  });

  test("returns no labels when the lookup fails", async () => {
    expect(await fetchPrLabels(sha, respond({ message: "rate limited" }, 403))).toEqual([]);
    const reject = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchPrLabels(sha, reject)).toEqual([]);
    expect(await fetchPrLabels(undefined, respond([pull({})]))).toEqual([]);
  });
});
