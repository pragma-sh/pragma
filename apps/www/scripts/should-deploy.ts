#!/usr/bin/env bun
/**
 * Vercel's Ignored Build Step: exit 1 to build, exit 0 to skip.
 *
 * Wired up by `vercel.json`'s `ignoreCommand`. The decision itself lives in
 * `src/lib/deploy.ts` so it is unit-tested rather than trusted.
 */
import { DEPLOY_LABEL, fetchPrLabels, needsPrLabels, shouldDeploy } from "../src/lib/deploy";

const context = {
  env: process.env.VERCEL_ENV,
  commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE,
};
const prLabels = needsPrLabels(context)
  ? await fetchPrLabels(process.env.VERCEL_GIT_COMMIT_SHA)
  : undefined;
const build = shouldDeploy({ ...context, prLabels });

console.log(
  build
    ? "building"
    : `skipping: production is reserved for Release Please release commits and pull requests labelled ${DEPLOY_LABEL} (redeploy from the dashboard to override)`,
);
process.exit(build ? 1 : 0);
