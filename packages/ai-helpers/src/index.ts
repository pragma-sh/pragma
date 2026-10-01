/**
 * `@pragma-sh/ai-helpers` — Pragma's lightweight AI layer over the pi coding-agent
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
  type AgentProgressActivity,
  type AgentProgressDeps,
  AgentProgressError,
  type AgentProgressRequest,
  type AgentProgressResult,
  estimateAgentProgress,
  parseAgentProgressRequest,
} from "./agent-progress.ts";
export {
  ASK_AI_TOOLS,
  type AskAiPromptContext,
  type AskAiWorktreeRef,
  NoQuestionError,
  streamAskAi,
  type StreamAskAiOptions,
} from "./ask-ai.ts";
export {
  autoSelect,
  type AutoSelectAgent,
  type AutoSelectDeps,
  AutoSelectError,
  type AutoSelectInsights,
  type AutoSelectModel,
  type AutoSelectReasoning,
  type AutoSelectRequest,
  type AutoSelectResult,
  DIFFICULTY_LEVELS,
  harnessMatchesAgent,
  modelInsightFor,
  parseAutoSelectRequest,
  reasoningForDifficulty,
  rowMatchesModel,
  type Tier,
  tier,
} from "./auto-select.ts";
export {
  applyAutoModeFilters,
  type AutoModeCandidate,
  type AutoModeFilter,
  type AutoModePreferences,
  type AutoModePriority,
  EMPTY_AUTO_MODE,
  globToRegExp,
  mergeAutoMode,
  type MergedAutoModePreferences,
  parseAutoMode,
  shortAgentId,
  type ParsedAutoMode,
} from "./automode.ts";
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
  applyResolutions,
  CONFLICT_CHOICES,
  type ConflictChoice,
  type ConflictHunk,
  type ConflictResolution,
  hasConflictMarkers,
  MalformedConflictError,
  parseConflicts,
  type ParsedConflictFile,
  resolveHunk,
} from "./conflict-markers.ts";
export {
  buildConflictQuestions,
  buildConflictState,
  combinedScore,
  type ConflictFileInput,
  type ConflictFileOutcome,
  type ConflictPullRequest,
  escalationReason,
  type HunkDecision,
  parseResolveConflictsRequest,
  readSystem1Answers,
  resolveMergeConflicts,
  type ResolveConflictsDeps,
  type ResolveConflictsProgress,
  type ResolveConflictsRequest,
  RISK_LEVELS,
  type System1HunkAnswer,
  type VerifyConflicts,
} from "./merge-conflicts.ts";
export {
  AUTO_SELECT,
  HARNESS_INSIGHTS,
  MERGE_CONFLICTS,
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
  harnessCachePath,
  type HarnessInsight,
  type HarnessInsights,
  loadHarnessInsights,
  NO_HARNESS_INSIGHTS,
  parseLeaderboardHtml,
} from "./harness-insights.ts";
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
  buildConflictVerificationPrompt,
  cleanConflictVerification,
  type ConflictVerificationAnswer,
  type ConflictVerificationHunk,
  type ConflictVerificationPromptContext,
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
