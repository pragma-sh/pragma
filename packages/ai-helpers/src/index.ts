/**
 * `@pragma/ai-helpers` — Pragma's lightweight AI layer over the pi coding-agent
 * SDK. Centralizes authentication, model selection, prompts, and the built-in
 * AI features (currently: commit-message and pull-request generation).
 */
export {
  type AiAuthMethod,
  createAuthStorage,
  createModelRegistry,
  isAiAvailable,
  listAuthMethods,
  loginOAuth,
  logout,
  setApiKey,
  signedInProviders,
} from "./auth.ts";
export {
  ASK_AI_TOOLS,
  type AskAiPromptContext,
  type AskAiWorktreeRef,
  NoQuestionError,
  streamAskAi,
  type StreamAskAiOptions,
} from "./ask-ai.ts";
export {
  generateCommitMessage,
  type GenerateCommitMessageOptions,
  NoStagedChangesError,
} from "./commit-message.ts";
export {
  generateCommitPlan,
  type GenerateCommitPlanOptions,
  NoWorktreeChangesError,
} from "./commit-plan.ts";
export {
  MODEL_INSIGHTS,
  type ModelKind,
  PICK_MODEL,
  type PriceAnchor,
  RUN_FALLBACK,
} from "./constants.ts";
export {
  generateInlineEdit,
  type GenerateInlineEditOptions,
  INLINE_EDIT_TOOLS,
  NoInstructionError,
} from "./inline-edit.ts";
export {
  type DatedModel,
  isModelRecent,
  isOlderThanMonths,
  parseModelReleaseDate,
} from "./model-date.ts";
export {
  indexInsights,
  insightCachePath,
  insightFor,
  insightKey,
  loadModelInsights,
  type ModelInsight,
  type ModelInsights,
  NO_INSIGHTS,
} from "./model-insights.ts";
export {
  pickModel,
  priceCeiling,
  quantile,
  selectModel,
  selectModelCandidates,
  type SelectModelOptions,
} from "./pick-model.ts";
export {
  buildAskAiPrompt,
  buildCommitMessagePrompt,
  buildCommitPlanPrompt,
  cleanCommitMessage,
  cleanCommitPlanDraft,
  COMMIT_DIFF_CHAR_LIMIT,
  COMMIT_PLAN_DIFF_CHAR_LIMIT,
  type CommitPlanDraft,
  type CommitPlanPromptContext,
} from "./prompts.ts";
export {
  buildInlineEditPrompt,
  cleanInlineEditDraft,
  INLINE_EDIT_FILE_CHAR_LIMIT,
  INLINE_EDIT_WINDOW_LINES,
  type InlineEditDraft,
  type InlineEditPromptContext,
  type InlineEditReplacement,
} from "./prompts.ts";
export {
  generatePullRequestDraft,
  type GeneratePullRequestDraftOptions,
  NoCommittedChangesError,
} from "./pull-request.ts";
export {
  buildPullRequestPrompt,
  cleanPullRequestDraft,
  PULL_REQUEST_DIFF_CHAR_LIMIT,
  type PullRequestDraft,
  type PullRequestPromptContext,
} from "./prompts.ts";
export {
  type AttemptFailure,
  classifyFailure,
  describeFailure,
  type FailureScope,
  NoWorkingModelError,
} from "./run-failure.ts";
export {
  createPragmaSession,
  type CreatePragmaSessionOptions,
  type PragmaSession,
  runPromptStreamingWithFallback,
  runPromptToText,
} from "./session.ts";
