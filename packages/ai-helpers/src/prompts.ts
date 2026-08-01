/**
 * Prompt text for Pragma's built-in AI features. Kept here so prompts are
 * versioned in one place and unit-testable, separate from the SDK plumbing.
 */

/** Strip a surrounding markdown code fence from model output, if present. */
function stripModelFence(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:[a-zA-Z]*)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  return text;
}

/** Keep only the outermost `{…}` object from model text (fences already stripped). */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

/** Hard cap on how much staged diff we feed the model, in characters. */
export const COMMIT_DIFF_CHAR_LIMIT = 24_000;

/** Hard cap on how much whole-worktree diff we feed the commit-plan model. */
export const COMMIT_PLAN_DIFF_CHAR_LIMIT = 80_000;

/** Hard cap on the committed branch diff included in the PR prompt. */
export const PULL_REQUEST_DIFF_CHAR_LIMIT = 80_000;

/** Hard cap on how much of the edited buffer is sent with an inline edit. */
export const INLINE_EDIT_FILE_CHAR_LIMIT = 60_000;

/** Lines of the file kept around the selection when the buffer is truncated. */
export const INLINE_EDIT_WINDOW_LINES = 400;

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
  return stripModelFence(raw).trim();
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
  const parsed = JSON.parse(extractJsonObject(stripModelFence(raw))) as Partial<CommitPlanDraft>;
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
    '- Do not ask the user questions or include meta follow-ups like "if you want me to"; focus only on the PR title and body.',
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
  const parsed = JSON.parse(extractJsonObject(stripModelFence(raw))) as Partial<PullRequestDraft>;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!title) {
    throw new Error("The model returned no pull request title.");
  }
  return { title, body };
}

/** Input context for one inline edit of an open editor buffer. */
export interface InlineEditPromptContext {
  /** Worktree-relative path of the file being edited. */
  filePath: string;
  /** The user's instruction, typed under the selection. */
  instruction: string;
  /** Full text of the *buffer* (which may differ from the file on disk). */
  doc: string;
  /** 1-based first line of the selection. */
  startLine: number;
  /** 1-based last line of the selection (inclusive). */
  endLine: number;
}

/** One exact-text replacement the model wants applied to the buffer. */
export interface InlineEditReplacement {
  /** Text to find in the buffer. Must match exactly once. */
  oldText: string;
  /** Replacement text. Empty means "delete `oldText`". */
  newText: string;
}

/** The set of replacements a model proposed for one inline-edit request. */
export interface InlineEditDraft {
  edits: InlineEditReplacement[];
  /** One-line summary of what the edits do, shown above the diff. */
  summary: string;
}

/** The window of `doc` sent to the model, plus how it was framed. */
interface InlineEditWindow {
  /** Line-numbered buffer text. */
  text: string;
  /** True when only part of the buffer is included. */
  truncated: boolean;
}

/** Prefixes every line with its 1-based number so the model can locate the selection. */
function numberLines(lines: readonly string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(width, " ")}\t${line}`)
    .join("\n");
}

/**
 * The buffer as the model sees it: the whole file when it fits, otherwise a
 * window of {@link INLINE_EDIT_WINDOW_LINES} lines centered on the selection so
 * the anchors the model picks still exist in the text it was shown.
 */
function inlineEditWindow(context: InlineEditPromptContext): InlineEditWindow {
  const lines = context.doc.split("\n");
  if (context.doc.length <= INLINE_EDIT_FILE_CHAR_LIMIT) {
    return { text: numberLines(lines, 1), truncated: false };
  }
  const half = Math.floor(INLINE_EDIT_WINDOW_LINES / 2);
  const from = Math.max(0, context.startLine - 1 - half);
  const to = Math.min(lines.length, context.endLine + half);
  return { text: numberLines(lines.slice(from, to), from + 1), truncated: true };
}

/** The selected text, taken from the buffer by line range. */
function selectedLines(context: InlineEditPromptContext): string {
  return context.doc
    .split("\n")
    .slice(context.startLine - 1, context.endLine)
    .join("\n");
}

/**
 * Build the standard-model prompt for an inline edit: the user's instruction,
 * the lines they highlighted, and the buffer they were highlighted in.
 *
 * The model answers with exact-text replacements rather than writing the file,
 * because the buffer is the source of truth (it may be unsaved) and Pragma
 * renders the result as an accept/reject diff before anything is applied.
 */
export function buildInlineEditPrompt(context: InlineEditPromptContext): string {
  const window = inlineEditWindow(context);
  const selection = selectedLines(context);

  return [
    "Edit an open editor buffer to satisfy the user's instruction.",
    "",
    `File: \`${context.filePath}\``,
    `Selected lines: ${context.startLine}-${context.endLine}`,
    "",
    "The user's instruction:",
    "",
    `> ${context.instruction.split("\n").join("\n> ")}`,
    "",
    "You have read-only tools (read, grep, find, ls) over the whole repository.",
    "Use them whenever the instruction depends on code, types, or conventions defined elsewhere;",
    "the answer must fit how this codebase already works.",
    "",
    "Rules:",
    "- Change only this file. You cannot write files; return the edits instead.",
    "- Edits may touch any part of the buffer, not only the selected lines (e.g. adding an import).",
    "- `oldText` must appear EXACTLY ONCE in the buffer below. Include whole lines, plus enough",
    "  neighboring lines to be unique, and reproduce their indentation and whitespace exactly.",
    "- Do not include the line-number prefixes shown below in `oldText` or `newText`.",
    "- Use an empty `newText` to delete `oldText`.",
    "- Keep the edits minimal: do not reformat, reorder, or rewrite code the instruction did not ask about.",
    "- Match the file's existing style, indentation, quoting, and naming.",
    "- If the instruction cannot be done, return an empty `edits` array and say why in `summary`.",
    '- Output ONLY valid JSON with this exact shape: {"summary": string, "edits": [{"oldText": string, "newText": string}]}.',
    "",
    "Selected text:",
    "```",
    selection || "(empty selection)",
    "```",
    "",
    window.truncated
      ? "Buffer (line-numbered, truncated around the selection):"
      : "Buffer (line-numbered):",
    "```",
    window.text,
    "```",
  ].join("\n");
}

/** One worktree listed in an ask-AI prompt so the model can open its path. */
export interface AskAiWorktreeRef {
  /** Display title (falls back to branch in the UI). */
  title: string;
  branch: string;
  /** Absolute filesystem path the read-only tools may open. */
  path: string;
  /** True for the worktree the user currently has selected in Pragma. */
  selected: boolean;
}

/** Context for {@link buildAskAiPrompt}. */
export interface AskAiPromptContext {
  /** The user's free-form question from the command palette. */
  question: string;
  /** Every non-hidden worktree in the selected project. */
  worktrees: AskAiWorktreeRef[];
}

/**
 * Build the standard-model prompt for a one-shot codebase question. Tools stay
 * read-only; the model answers in markdown and must not claim it can edit or run
 * commands.
 */
export function buildAskAiPrompt(context: AskAiPromptContext): string {
  const worktreeLines =
    context.worktrees.length === 0
      ? ["(no worktrees listed)"]
      : context.worktrees.map((worktree) => {
          const label = worktree.title.trim() || worktree.branch;
          const mark = worktree.selected ? " (currently selected in Pragma)" : "";
          return `- ${label} — branch \`${worktree.branch}\` — path \`${worktree.path}\`${mark}`;
        });

  return [
    "Answer the user's question about this codebase.",
    "",
    "You have read-only tools (read, grep, find, ls) over the project.",
    "Use them to inspect source, configs, and docs before answering when the question depends on the code.",
    "You cannot write files, edit the repository, or run shell commands — never claim that you did.",
    "",
    "The user is working in Pragma. Prefer the currently selected worktree when paths are ambiguous,",
    "but you may read any worktree listed below (the whole project).",
    "",
    "Project worktrees:",
    ...worktreeLines,
    "",
    "Rules:",
    "- Answer in clear GitHub-flavored markdown.",
    "- Cite file paths (and line ranges when useful) from what you actually read.",
    "- Be concise; lead with the direct answer, then supporting detail.",
    "- If you cannot find enough evidence in the codebase, say what you checked and what is still unknown.",
    "- Do not invent APIs, files, or behavior.",
    "",
    "User question:",
    "",
    context.question.trim(),
  ].join("\n");
}

/** Normalize and parse a model's raw inline-edit JSON. */
export function cleanInlineEditDraft(raw: string): InlineEditDraft {
  const parsed = JSON.parse(extractJsonObject(stripModelFence(raw))) as Partial<InlineEditDraft>;
  const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
  const cleaned = edits
    .map((edit) => ({
      oldText: typeof edit.oldText === "string" ? edit.oldText : "",
      newText: typeof edit.newText === "string" ? edit.newText : "",
    }))
    .filter((edit) => edit.oldText !== "" && edit.oldText !== edit.newText);

  return {
    edits: cleaned,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
  };
}
