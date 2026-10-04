/**
 * Whether a Vercel deployment should build, for the project's Ignored Build Step.
 *
 * Production is reserved for releases: the site is the update endpoint and the
 * docs contract for whatever desktop build is current, so it should change when
 * a release changes it and not on every merge to `main`. The one exception is a
 * merged pull request labelled {@link DEPLOY_LABEL} — a blog post or copy change
 * that describes nothing unreleased. Previews are untouched, because reviewing a
 * docs change is exactly what they are for.
 */

import { githubHeaders, repoApiUrl } from "./github-api";

/** Pull-request label that ships a merge to production without waiting for a release. */
export const DEPLOY_LABEL = "deploy:www";

/** How long the Ignored Build Step waits on GitHub before falling back to the release rule. */
const LABEL_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Release Please's own commits, in both shapes this repo can produce.
 *
 * Every pattern is anchored and matched against the **subject line only**. An
 * unanchored search over the whole message would let any commit whose body
 * happens to quote a release branch — a PR description, a revert, a changelog
 * paste — deploy production without a release behind it.
 */
const RELEASE_COMMIT_PATTERNS = [
  // Squash or rebase merge: the PR title, `chore${scope}: release${component} ${version}`.
  /^chore(\([^)]*\))?: release\b/,
  // Merge commit: GitHub's default subject names the source branch, and Release
  // Please always pushes to `release-please--branches--<target>`.
  /^Merge pull request #\d+ from [^\s/]+\/release-please--branches--/,
  // A local `git merge` of the same branch, with or without a remote prefix.
  /^Merge branch '(?:[^'/]+\/)?release-please--branches--/,
] as const;

/** Inputs the Ignored Build Step reads from Vercel's environment. */
export interface DeployContext {
  /** `VERCEL_ENV` — `production`, `preview`, or `development`. */
  env: string | undefined;
  /** `VERCEL_GIT_COMMIT_MESSAGE` — subject and body of the deploying commit. */
  commitMessage: string | undefined;
  /** Labels of the merged pull request that produced the commit, when looked up. */
  prLabels?: readonly string[];
}

/** Returns true when the commit message's subject is a Release Please release commit. */
function isReleaseCommit(commitMessage: string): boolean {
  const subject = commitMessage.trimStart().split("\n", 1)[0] ?? "";
  return RELEASE_COMMIT_PATTERNS.some((pattern) => pattern.test(subject));
}

/**
 * Returns true when the decision hinges on the pull request's labels — a
 * production deployment of a readable, non-release commit — so the caller
 * only spends a GitHub request when it can change the answer.
 */
export function needsPrLabels({ env, commitMessage }: DeployContext): boolean {
  return env === "production" && commitMessage !== undefined && !isReleaseCommit(commitMessage);
}

/**
 * Returns true when this deployment should build.
 *
 * Anything that is not a production deployment builds. A production deployment
 * builds for a Release Please release commit, or for a merge whose pull request
 * carries {@link DEPLOY_LABEL}. An absent commit message builds: a deployment
 * whose provenance cannot be read is not one to silently skip, and the same
 * applies if this script cannot run at all — a failing Ignored Build Step is
 * treated by Vercel as "build".
 */
export function shouldDeploy(context: DeployContext): boolean {
  if (!needsPrLabels(context)) return true;
  return context.prLabels?.includes(DEPLOY_LABEL) ?? false;
}

interface CommitPull {
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: { name: string }[];
}

/**
 * Labels of the merged pull request whose merge produced `sha`.
 *
 * Only a pull request whose `merge_commit_sha` is `sha` counts, so a commit that
 * merely passed through a labelled branch cannot deploy on its behalf. Any
 * failure — network, rate limit, timeout — returns no labels: the label is an
 * opt-in, and a lookup that cannot confirm it leaves the release-only rule in
 * charge rather than shipping unreleased docs.
 */
export async function fetchPrLabels(
  sha: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (!sha) return [];
  try {
    const response = await fetchImpl(`${repoApiUrl}/commits/${sha}/pulls`, {
      headers: githubHeaders("pragma-deploy"),
      signal: AbortSignal.timeout(LABEL_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const pulls = (await response.json()) as CommitPull[];
    return pulls
      .filter((pull) => pull.merged_at !== null && pull.merge_commit_sha === sha)
      .flatMap((pull) => pull.labels.map((label) => label.name));
  } catch {
    return [];
  }
}
