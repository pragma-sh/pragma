/**
 * Whether a Vercel deployment should build, for the project's Ignored Build Step.
 *
 * Production is reserved for releases: the site is the update endpoint and the
 * docs contract for whatever desktop build is current, so it should change when
 * a release changes it and not on every merge to `main`. Previews are untouched,
 * because reviewing a docs change is exactly what they are for.
 */

/** Release Please's own commits, in both shapes this repo can produce. */
const RELEASE_COMMIT_PATTERNS = [
  // Squash or rebase merge: the PR title, `chore${scope}: release${component} ${version}`.
  /^chore(\([^)]*\))?: release\b/,
  // Merge commit: GitHub's default subject names the source branch, and Release
  // Please always pushes to `release-please--branches--<target>`.
  /release-please--branches--/,
] as const;

/** Inputs the Ignored Build Step reads from Vercel's environment. */
export interface DeployContext {
  /** `VERCEL_ENV` — `production`, `preview`, or `development`. */
  env: string | undefined;
  /** `VERCEL_GIT_COMMIT_MESSAGE` — subject and body of the deploying commit. */
  commitMessage: string | undefined;
}

/**
 * Returns true when this deployment should build.
 *
 * Anything that is not a production deployment builds. A production deployment
 * builds only for a Release Please release commit. An absent commit message
 * builds: a deployment whose provenance cannot be read is not one to silently
 * skip, and the same applies if this script cannot run at all — a failing
 * Ignored Build Step is treated by Vercel as "build".
 */
export function shouldDeploy({ env, commitMessage }: DeployContext): boolean {
  if (env !== "production") return true;
  if (commitMessage === undefined) return true;
  return RELEASE_COMMIT_PATTERNS.some((pattern) => pattern.test(commitMessage.trimStart()));
}
