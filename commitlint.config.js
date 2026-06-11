/**
 * Conventional Commits, enforced both locally (husky `commit-msg`) and in CI.
 * https://www.conventionalcommits.org
 *
 * Format: <type>(<scope>): <subject>
 *   types  — feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
 *   scope  — optional; prefer a package/app name (e.g. pragma, constants, ci, deps)
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0, "always"],
  },
};
