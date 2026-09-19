#!/usr/bin/env bun
/**
 * Vercel's Ignored Build Step: exit 1 to build, exit 0 to skip.
 *
 * Wired up by `vercel.json`'s `ignoreCommand`. The decision itself lives in
 * `src/lib/deploy.ts` so it is unit-tested rather than trusted.
 */
import { shouldDeploy } from "../src/lib/deploy";

const build = shouldDeploy({
  env: process.env.VERCEL_ENV,
  commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE,
});

console.log(
  build
    ? "building"
    : "skipping: production is reserved for Release Please release commits (redeploy from the dashboard to override)",
);
process.exit(build ? 1 : 0);
