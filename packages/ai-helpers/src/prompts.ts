/**
 * Prompt text for Pragma's built-in AI features. Kept here so prompts are
 * versioned in one place and unit-testable, separate from the SDK plumbing.
 */

/** Hard cap on how much staged diff we feed the model, in characters. */
export const COMMIT_DIFF_CHAR_LIMIT = 24_000;

/** Hard cap on how much whole-worktree diff we feed the commit-plan model. */
export const COMMIT_PLAN_DIFF_CHAR_LIMIT = 80_000;

/** Hard cap on the committed branch diff included in the PR prompt. */
export const PULL_REQUEST_DIFF_CHAR_LIMIT = 80_000;

/**
 * Build the one-shot prompt that turns a staged git diff into a commit message.
 * All instructions live in the user prompt because the pi SDK owns the system
 * prompt.
 */
export function buildCommitMessagePrompt(stagedDiff: string): string {
  const diff =
    stagedDiff.length > COMMIT_DIFF_CHAR_LIMIT
      ? `${stagedDiff.slice(0, COMMIT_DIFF_CHAR_LIMIT)}\n[... diff truncated ...]`
      : stagedDiff;

  return [
    "Write a git commit message for the following staged changes.",
    "",
    "Before writing the message, determine the repository's commit convention:",
    "- Read AGENTS.md for a specific commit convention.",
    "- If AGENTS.md does not define one, inspect `git log` for an existing pattern.",
    "- If there is still no convention, fall back to Conventional Commits.",
    "",
    "Rules:",
    "- Follow the discovered convention exactly.",
    "- If falling back to Conventional Commits, use `<type>(<scope>): <subject>`.",
    "- Conventional Commit types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "- For Conventional Commits, scope is optional; prefer a package/app name when one is obvious.",
    "- Subject: imperative mood, lower-case, no trailing period, <= 72 characters.",
    "- Add a body only if it adds real information; wrap it at ~72 columns and explain the why.",
    "- Output ONLY the commit message as text. No backticks, no preamble, no explanation.",
    "",
    "Staged diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * Normalize a model's raw commit-message output: strip surrounding code fences,
 * stray quotes, and leading/trailing whitespace.
 */
export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:[a-zA-Z]*)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  return text.trim();
}

/** Input context used to group every worktree change into commits. */
export interface CommitPlanPromptContext {
  /** Exact worktree-relative paths that may be included in the plan. */
  allowedPaths: string[];
  /** `git status --short` for the complete dirty worktree. */
  status: string;
  /** `git diff --stat HEAD` plus untracked-file summaries where available. */
  diffStat: string;
  /** Full worktree diff against HEAD. The prompt builder may truncate it. */
  worktreeDiff: string;
}

/** One logical commit in an AI-generated commit plan. */
export interface CommitPlanCommit {
  message: string;
  paths: string[];
}

/** A set of logical commits that covers the dirty worktree. */
export interface CommitPlanDraft {
  commits: CommitPlanCommit[];
}

/** Build the standard-model prompt for grouping all current changes into commits. */
export function buildCommitPlanPrompt(context: CommitPlanPromptContext): string {
  const diff =
    context.worktreeDiff.length > COMMIT_PLAN_DIFF_CHAR_LIMIT
      ? `${context.worktreeDiff.slice(0, COMMIT_PLAN_DIFF_CHAR_LIMIT)}\n[... diff truncated ...]`
      : context.worktreeDiff;

  return [
    "Plan multiple git commits for the following dirty worktree.",
    "",
    "Before writing the plan, determine the repository's commit convention:",
    "- Read AGENTS.md for a specific commit convention.",
    "- If AGENTS.md does not define one, inspect `git log` for an existing pattern.",
    "- If there is still no convention, fall back to Conventional Commits.",
    "",
    "Group the changes into the smallest number of logical commits that would be easy to review.",
    "If unrelated features, fixes, tests, docs, or refactors are present, split them into separate commits.",
    "A file cannot be split by hunks here; assign each changed path to exactly one commit.",
    "",
    "Rules:",
    "- Every path in `allowedPaths` must appear exactly once across the commits.",
    "- Do not include any path that is not listed in `allowedPaths`.",
    "- Follow the discovered commit convention exactly for each message.",
    "- If falling back to Conventional Commits, use `<type>(<scope>): <subject>`.",
    "- Conventional Commit types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "- For Conventional Commits, scope is optional; prefer a package/app name when one is obvious.",
    "- Subject: imperative mood, lower-case, no trailing period, <= 72 characters.",
    "- Add a body only if it adds real information; wrap it at ~72 columns and explain the why.",
    '- Output ONLY valid JSON with this exact shape: {"commits": [{"message": string, "paths": string[]}]}.',
    "",
    "Allowed paths:",
    "```json",
    JSON.stringify(context.allowedPaths, null, 2),
    "```",
    "",
    "Git status:",
    "```text",
    context.status.trim() || "(no status)",
    "```",
    "",
    "Change summary:",
    "```text",
    context.diffStat.trim() || "(no summary)",
    "```",
    "",
    "Worktree diff:",
    "```diff",
    diff.trim() || "(no tracked diff; inspect untracked files with tools if needed)",
    "```",
  ].join("\n");
}

/** Normalize and parse a model's raw commit-plan JSON. */
export function cleanCommitPlanDraft(raw: string): CommitPlanDraft {
  let text = raw.trim();
  const fence = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  const parsed = JSON.parse(text) as Partial<CommitPlanDraft>;
  const commits = Array.isArray(parsed.commits) ? parsed.commits : [];
  const cleaned = commits
    .map((commit) => ({
      message: typeof commit.message === "string" ? cleanCommitMessage(commit.message) : "",
      paths: Array.isArray(commit.paths)
        ? commit.paths.filter(
            (path): path is string => typeof path === "string" && path.trim() !== "",
          )
        : [],
    }))
    .filter((commit) => commit.message && commit.paths.length > 0);

  if (cleaned.length === 0) {
    throw new Error("The model returned no commit plan.");
  }
  return { commits: cleaned };
}

/** Input context used to draft a pull request title and body. */
export interface PullRequestPromptContext {
  /** `git log` for the branch commits, oldest first. */
  gitLog: string;
  /** `git diff --stat` for the committed branch delta. */
  diffStat: string;
  /** Full committed branch diff. The prompt builder may truncate it. */
  committedDiff: string;
}

/** The generated pull request title and markdown description. */
export interface PullRequestDraft {
  title: string;
  body: string;
}

/** Build the standard-model prompt for generating a PR title and markdown body. */
export function buildPullRequestPrompt(context: PullRequestPromptContext): string {
  const diff =
    context.committedDiff.length > PULL_REQUEST_DIFF_CHAR_LIMIT
      ? `${context.committedDiff.slice(0, PULL_REQUEST_DIFF_CHAR_LIMIT)}\n[... diff truncated ...]`
      : context.committedDiff;

  return [
    "Write a GitHub pull request title and markdown description for this branch.",
    "",
    "Base the result primarily on the branch's committed git log and committed changes.",
    "If the commits and diff do not give the full picture, use your tools to inspect the repository and changed code before answering.",
    "",
    "Rules:",
    "- Use a concise, review-friendly title in imperative mood when possible.",
    "- The body should summarize what changed and why, with useful reviewer context.",
    "- Mention tests only when the commits or code changes show test changes or clear validation steps.",
    "- Do not invent ticket numbers, deployment notes, metrics, or test results.",
    '- Output ONLY valid JSON with this exact shape: {"title": string, "body": string}.',
    "- The body string must contain GitHub-flavored markdown.",
    "",
    "Branch git log (oldest first):",
    "```text",
    context.gitLog.trim() || "(no commits)",
    "```",
    "",
    "Committed change summary:",
    "```text",
    context.diffStat.trim() || "(no committed file changes)",
    "```",
    "",
    "Committed diff:",
    "```diff",
    diff.trim() || "(no committed diff)",
    "```",
  ].join("\n");
}

/** Normalize and parse a model's raw PR draft JSON. */
export function cleanPullRequestDraft(raw: string): PullRequestDraft {
  let text = raw.trim();
  const fence = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  const parsed = JSON.parse(text) as Partial<PullRequestDraft>;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!title) {
    throw new Error("The model returned no pull request title.");
  }
  return { title, body };
}
