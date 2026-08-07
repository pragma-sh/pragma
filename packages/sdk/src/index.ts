export { PragmaClient } from "./client";
export { AssetsClient, type FetchedAsset } from "./assets-client";
export { WorkspaceClient, type WorkspaceSubscriptionEvent } from "./workspace-client";
export { PushClient, type PushRegistration } from "./push-client";
export { ThemeClient, type GetThemeOptions } from "./theme-client";
export { runtimeAgentId, ScratchpadsClient } from "./scratchpads-client";
export { base64ToBytes, bytesToBase64 } from "./encoding";
export { PRAGMA_ENV_KEYS, hasPragmaEnvironment, readEnv } from "./env";
export { PragmaGatewayError, PragmaTransportError } from "./errors";
export {
  awaitAgentAnswer,
  awaitAgentDecision,
  reportAttention,
  reportCleared,
  reportMessage,
  reportSessionName,
  reportStarted,
  reportStopped,
} from "./agents-client";
export type { AwaitAnswerOptions, AwaitDecisionOptions } from "./agents-client";
export type { PragmaClientConfig } from "./transport";
export type {
  AgentAnswer,
  AgentAnswerEvent,
  AgentAttentionKind,
  AgentConnection,
  AgentDecision,
  AgentDecisionEvent,
  AgentEvent,
  AgentInput,
  AgentInputEvent,
  AgentInterrupt,
  AgentInterruptEvent,
  AgentCatalog,
  AgentModelEntry,
  AgentReasoning,
  CatalogAgent,
  AgentIcon,
  AgentMessage,
  AgentMessageEvent,
  AgentReportPayload,
  QuestionOption,
  AgentSessionLaunchPayload,
  AgentSessionLaunchResult,
  AgentStreamEvent,
  AgentStatus,
  ConnectOptions,
  ReportMessageOptions,
  ReportOptions,
  ReportSessionNameOptions,
  WorkspaceSnapshot,
} from "./types/agents";
export type { CommandResult, ExecRunRequest } from "./types/exec";
export type { HostTheme, ThemeMode, ThemeOverrides, ThemeSources } from "./types/theme";
export type {
  AttachScratchpadAgentOptions,
  CommentScratchpadOptions,
  GetScratchpadsOptions,
  ScratchpadBlock,
  ScratchpadComment,
  ScratchpadFile,
  ScratchpadRef,
  SendAttachedOptions,
  SendAttachedResult,
} from "./types/scratchpads";
export type {
  DirEntry,
  FileContents,
  RenameRequest,
  WorktreePathRequest,
  WriteFileRequest,
} from "./types/fs";
export type {
  BranchSyncStatus,
  FileDiff,
  GithubRepoInfo,
  GitPayload,
  MergedStatusItem,
  WorktreeChanges,
} from "./types/git";
export type {
  SessionEvent,
  SpawnSessionRequest,
  SpawnSessionResponse,
  StreamOptions,
} from "./types/sessions";
