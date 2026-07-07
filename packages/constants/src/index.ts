import values from "../values.json";
import type { Constants } from "./generated/constants";

export type {
  Constants,
  AppInfo,
  WindowDefaults,
  Links,
  EditorLaunchers,
  EditorLauncher,
  Scripts,
  Agents,
  Gateway,
  Protocol,
  ProtocolRpcMethod,
  ProtocolEventKind,
  ProtocolErrorCode,
  ControlMethod,
  ProjectScriptsConfig,
  RunScriptEntry,
  RunScriptNode,
  RunScriptSplit,
  RunScriptHorizontalSplit,
  RunScriptVerticalSplit,
  ScriptRunStatus,
  SplitTabLeaf,
  SplitHorizontal,
  SplitVertical,
  SplitSplit,
  SplitNode,
  Project,
  Worktree,
  WorktreeStatus,
  AgentStatus,
  AgentReportKind,
  AgentAttentionKind,
  AgentMessageKind,
  AgentMessageRole,
  AgentToolCallStatus,
  AgentFileChangeKind,
  AgentToolCall,
  AgentFileChange,
  AgentMessage,
  AgentReportPayload,
  AgentDecision,
  AgentAnswer,
  AgentInput,
  Tab,
  TabKind,
  DirEntry,
  DiffSide,
  ChangeStatus,
  ChangedFile,
  WorktreeChanges,
  FileDiff,
  FileChange,
  FileChangeKind,
  FileContents,
  ProjectIcon,
  KanbanPromptStatus,
  KanbanCompletedAction,
  KanbanSchedulingMode,
  KanbanPromptCard,
  GitHub,
  GitHubUser,
  GitHubAuthStatus,
  BranchSyncStatus,
  GitHubRepoRef,
  KeybindingChord,
  PlatformChord,
  Keybindings,
  KeybindingsConfig,
} from "./generated/constants";

/**
 * Shared application constants.
 *
 * The values live in `values.json` and are validated against `schema.json`.
 * The same JSON is consumed by the Rust backend (see `src/lib.rs`), so this is
 * the single source of truth across both languages.
 */
export const constants = values as Constants;

export default constants;
