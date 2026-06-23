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
  generateCommitMessage,
  type GenerateCommitMessageOptions,
  NoStagedChangesError,
} from "./commit-message.ts";
export {
  generateCommitPlan,
  type GenerateCommitPlanOptions,
  NoWorktreeChangesError,
} from "./commit-plan.ts";
export { type ModelKind, PICK_MODEL } from "./constants.ts";
export {
  type DatedModel,
  isModelRecent,
  isOlderThanMonths,
  parseModelReleaseDate,
} from "./model-date.ts";
export { pickModel, selectModel, selectModelCandidates } from "./pick-model.ts";
export {
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
  createPragmaSession,
  type CreatePragmaSessionOptions,
  type PragmaSession,
  runPromptToText,
} from "./session.ts";
