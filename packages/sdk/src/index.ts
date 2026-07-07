export { PragmaClient } from "./client";
export { base64ToBytes, bytesToBase64 } from "./encoding";
export { PRAGMA_ENV_KEYS, hasPragmaEnvironment, readEnv } from "./env";
export { PragmaGatewayError, PragmaTransportError } from "./errors";
export {
  awaitAgentAnswer,
  awaitAgentDecision,
  reportAttention,
  reportCleared,
  reportMessage,
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
  AgentMessage,
  AgentMessageEvent,
  AgentReportPayload,
  AgentStreamEvent,
  AgentStatus,
  ConnectOptions,
  ReportMessageOptions,
  ReportOptions,
} from "./types/agents";
export type { CommandResult, ExecRunRequest } from "./types/exec";
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
