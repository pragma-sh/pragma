import type { ReviewThread } from "@/lib/github";
import type { FixItComment } from "@/state/fix-it-store";

/** Captures a PR review thread as a fix-it list entry (joining its comment bodies). */
export function reviewThreadToFixItComment(thread: ReviewThread): FixItComment {
  return {
    threadId: thread.id,
    path: thread.path,
    line: thread.line,
    body: thread.comments
      .map((comment) => comment.body.trim())
      .filter((body) => body.length > 0)
      .join("\n\n"),
  };
}

/** A `path:line` (or bare `path`) location label for a fix-it comment. */
export function commentLocation(comment: FixItComment): string {
  return comment.line === null ? comment.path : `${comment.path}:${comment.line}`;
}

/** Renders a comment body as a markdown blockquote. */
function quoteBody(body: string): string {
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Prompt asking an agent to verify-and-fix a single code-review comment. */
export function buildSingleFixPrompt(comment: FixItComment): string {
  return [
    "Verify and fix a code review issue.",
    "First confirm the issue actually exists in the current code. If it is not present or no longer relevant, do not change anything — instead explain to the user why it is not relevant.",
    "",
    `The comment to address concerns \`${commentLocation(comment)}\` and is as follows:`,
    "",
    quoteBody(comment.body),
  ].join("\n");
}

/** Prompt asking an agent to verify-and-fix every comment on the fix-it list. */
export function buildListFixPrompt(
  comments: FixItComment[],
  options: { commitAndPush?: boolean } = {},
): string {
  const items = comments
    .map(
      (comment, index) =>
        `${index + 1}. \`${commentLocation(comment)}\`:\n${quoteBody(comment.body)}`,
    )
    .join("\n\n");
  const prompt = [
    "Verify and fix all of the following code review issues.",
    "For each one, first confirm the issue actually exists in the current code. If an issue is not present or no longer relevant, do not change anything for it — instead explain to the user why it is not relevant.",
    "",
    "The comments to address are as follows:",
    "",
    items,
  ];
  if (options.commitAndPush) {
    prompt.push(
      "",
      "After addressing all applicable issues, commit all resulting changes and push the current branch.",
    );
  }
  return prompt.join("\n");
}
