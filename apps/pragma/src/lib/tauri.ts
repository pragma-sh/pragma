import type {
  AppInfo,
  BranchSyncStatus,
  ChangeStatus,
  DiffSide,
  DirEntry,
  FileChange,
  FileContents,
  FileDiff,
  GitHubAuthStatus,
  GitHubRepoRef,
  GitHubUser,
  KanbanPromptCard,
  KanbanPromptStatus,
  KeybindingsConfig,
  Project,
  ProjectIcon,
  ProjectScriptsConfig,
  PaletteSearchResponse,
  Tab,
  TabKind,
  WorktreeChanges,
  Worktree,
  WorktreeStatus,
  AgentMessage,
  AgentReportPayload,
  AutomationInfo,
  AutomationRootRegistration,
} from "@pragma/constants";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Typed bridge to the Rust backend commands.
 *
 * Keep every `invoke` call behind a named function here so the rest of the app
 * never touches raw command strings — one place to keep the TS and Rust sides
 * in sync. See `src-tauri/src/lib.rs` for the matching `#[tauri::command]`s.
 */
export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/**
 * JSON control events from the daemon. Terminal **output** is not modeled here:
 * it arrives on the same channel as a raw {@link ArrayBuffer} (the backend sends
 * it as bytes, never JSON, so escape-heavy redraws aren't inflated and can be
 * fed straight into xterm). See {@link PtyMessage}.
 */
export type PtyEvent = { event: "title"; title: string } | { event: "exit"; code: number | null };

/** A message on a PTY channel: raw output bytes, or a JSON control event. */
export type PtyMessage = ArrayBuffer | PtyEvent;

export type PtyEventHandler = (message: PtyMessage) => void;

/** Agent launcher definition exposed by a Pragma plugin. */
export interface AgentConfig {
  id: string;
  name: string;
  iconPath?: string | null;
  iconDataUrl: string | null;
  start: string[];
  startupInput?: AgentStartupInput[] | null;
  prefillDelayMs?: number | null;
  prefillMode?: "bracketed" | "plain" | null;
  prefillSubmit?: string | null;
  prefillSubmitDelayMs?: number | null;
  models?: AgentModelsConfig | null;
}

/** Timed input sent after an agent starts and before an optional prompt prefill. */
export interface AgentStartupInput {
  delayMs: number;
  data: string;
}

/** Optional agent model discovery and launch-argument config. */
export type AgentModelsConfig =
  | {
      source: "static";
      modelArg?: string[] | null;
      reasoningArg?: string[] | null;
      modelReasoningArg?: string[] | null;
      items: RawAgentModel[];
    }
  | {
      source: "command";
      command: string[];
      modelArg?: string[] | null;
      reasoningArg?: string[] | null;
      modelReasoningArg?: string[] | null;
    };

/** Model entry returned by a plugin agent's model provider. */
export interface AgentModel {
  id: string;
  name: string;
  reasoning: AgentReasoning[];
}

/** Optional reasoning effort for a model. */
export interface AgentReasoning {
  id: string;
  name: string;
}

/** Raw static model entry mirrored from config metadata. */
export interface RawAgentModel {
  id: string;
  name: string;
  reasoning?: AgentReasoning[];
}

/** Selected model/reasoning for an agent launch; `modelId: null` means no model args. */
export interface AgentModelSelection {
  modelId: string | null;
  reasoningId: string | null;
}

/** Subscribes to daemon-forwarded agent status reports. */
export function onAgentReport(handler: (payload: AgentReportPayload) => void): Promise<UnlistenFn> {
  return listen<AgentReportPayload>("pragma:agent-report", (event) => handler(event.payload));
}

/** Subscribes to daemon-forwarded rich agent messages. */
export function onAgentMessage(handler: (payload: AgentMessage) => void): Promise<UnlistenFn> {
  return listen<AgentMessage>("pragma:agent-message", (event) => handler(event.payload));
}

/** Fires before the daemon replays its current agent-status snapshot. */
export function onAgentStatusReset(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("pragma:agent-status-reset", () => handler());
}

/** Subscribes to local automation approval requests from the host server. */
export function onAutomationPending(
  handler: (payload: AutomationInfo) => void,
): Promise<UnlistenFn> {
  return listen<AutomationInfo>("pragma:automation-pending", (event) => handler(event.payload));
}

/** Subscribes to automation list/runtime changes from the host server. */
export function onAutomationsChanged(
  handler: (payload: AutomationInfo[]) => void,
): Promise<UnlistenFn> {
  return listen<AutomationInfo[]>("pragma:automations-changed", (event) => handler(event.payload));
}

/** Registers known project/worktree roots with the host automation server. */
export function registerAutomationRoots(projects: AutomationRootRegistration[]): Promise<void> {
  return invoke("register_automation_roots", { projects });
}

/** Lists automations discovered by the host server. */
export function listAutomations(): Promise<AutomationInfo[]> {
  return invoke<AutomationInfo[]>("list_automations");
}

/** Approves a pending local automation. */
export function approveAutomation(id: string): Promise<void> {
  return invoke("approve_automation", { id });
}

/** Rejects a pending local automation without deleting its file. */
export function rejectAutomation(id: string): Promise<void> {
  return invoke("reject_automation", { id });
}

/** Runs a loaded automation immediately. */
export function runAutomationNow(id: string): Promise<void> {
  return invoke("run_automation_now", { id });
}

/**
 * Reads the `.ts` source backing an automation from whichever host owns the
 * server socket (local for local projects, the remote box for SSH-bridged ones).
 * Used by the Automations workspace preview editor; shared by global + local.
 */
export function readAutomationSource(id: string): Promise<FileContents> {
  return invoke<FileContents>("read_automation_source", { id });
}

/** Overwrites the `.ts` source backing an automation with UTF-8 text. */
export function writeAutomationSource(id: string, contents: string): Promise<void> {
  return invoke("write_automation_source", { id, contents });
}

/** Warns once when `~/.local/bin` is not on PATH after installing `pragma-cli`. */
export function onAgentCliPathWarning(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("pragma:agent-cli-path-warning", (event) => handler(event.payload));
}

/** Request to start one host-side plugin watcher instance. */
export interface StartPluginWatcherRequest {
  pluginId: string;
  pluginMain: string;
  agentId: string;
  watcherAgent: string;
  config: unknown;
  sessionId: string;
  tabId: string;
  worktreeId: string;
  gatewayUrl: string;
  gatewayToken: string;
}

/** Starts a detached watcher sidecar for a plugin-owned agent session. */
export function startPluginWatcher(request: StartPluginWatcherRequest): Promise<void> {
  return invoke("start_plugin_watcher", { request });
}

/** Workspace metadata event emitted after a brokered CLI mutation. */
export interface WorkspaceChangedEvent {
  action: string;
  projectId: string;
  worktreeId?: string | null;
  tabId?: string | null;
}

/** Subscribes to CLI-driven worktree mutations routed through the app controller. */
export function onWorktreeChanged(
  handler: (payload: WorkspaceChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceChangedEvent>("worktreeChanged", (event) => handler(event.payload));
}

/** Subscribes to CLI-driven tab mutations routed through the app controller. */
export function onTabsChanged(
  handler: (payload: WorkspaceChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceChangedEvent>("tabsChanged", (event) => handler(event.payload));
}

/** A mobile-requested agent session ready for background launch. */
export interface AgentSessionLaunchRequest {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  tabId: string;
  agentId: string;
  modelId: string | null;
  reasoningId: string | null;
  prompt: string | null;
}

/** Subscribes to mobile-requested agent sessions brokered through the desktop. */
export function onAgentSessionLaunch(
  handler: (payload: AgentSessionLaunchRequest) => void,
): Promise<UnlistenFn> {
  return listen<AgentSessionLaunchRequest>("pragma:agent-session-launch", (event) =>
    handler(event.payload),
  );
}

/** Destination emitted when the user clicks a native agent notification. */
export interface AgentNotificationClick {
  projectId: string;
  worktreeId: string;
  tabId: string;
}

/** Shows a clickable native notification when supported by the current platform. */
export function showAgentNotification(
  title: string,
  body: string,
  projectId: string,
  worktreeId: string,
  tabId: string,
): Promise<boolean> {
  return invoke<boolean>("show_agent_notification", { title, body, projectId, worktreeId, tabId });
}

/** Subscribes to native agent notification clicks. */
export function onAgentNotificationClick(
  handler: (payload: AgentNotificationClick) => void,
): Promise<UnlistenFn> {
  return listen<AgentNotificationClick>("pragma:agent-notification-clicked", (event) =>
    handler(event.payload),
  );
}

/**
 * Tells the daemon a tab's finished (`done`) agent indicators have been seen, so
 * it drops them and a later snapshot replay (on reconnect) doesn't resurrect the
 * green dot or re-fire its "finished" notification. `running`/`attention` persist.
 */
export function markAgentsSeen(tabId: string): Promise<void> {
  return invoke("mark_agents_seen", { tabId });
}

/**
 * Publishes a command-approval verdict from the approval toast. The server fans
 * it out to agent subscribers so the waiting harness hook (Claude Code) or plugin
 * watcher (cursor/opencode) runs or rejects the command keyed by `requestId`.
 */
export function resolveAgentApproval(params: {
  agent: string;
  worktreeId: string;
  tabId: string;
  requestId: string;
  approved: boolean;
}): Promise<void> {
  return invoke("resolve_agent_approval", params);
}

/**
 * Spawns a daemon-backed PTY session and streams events through a Tauri channel.
 * Resolves with the channel so callers can detach (`channel.onmessage = noop`)
 * when the terminal is disposed — Tauri has no explicit channel-close API.
 */
export function ptySpawn(
  sessionId: string,
  worktreeId: string,
  cwd: string,
  cols: number,
  rows: number,
  onEvent: PtyEventHandler,
): Promise<Channel<PtyMessage>> {
  const channel = new Channel<PtyMessage>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
  channel.onmessage = onEvent;
  return invoke<void>("pty_spawn", {
    sessionId,
    worktreeId,
    cwd,
    cols,
    rows,
    onEvent: channel,
  }).then(() => channel);
}

/**
 * Attaches to an existing daemon PTY session and replays daemon scrollback.
 * Resolves with the channel (see {@link ptySpawn}) so callers can detach it.
 */
export function ptyAttach(
  sessionId: string,
  cols: number,
  rows: number,
  onEvent: PtyEventHandler,
): Promise<Channel<PtyMessage>> {
  const channel = new Channel<PtyMessage>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
  channel.onmessage = onEvent;
  return invoke<void>("pty_attach", { sessionId, cols, rows, onEvent: channel }).then(
    () => channel,
  );
}

/** Writes raw terminal input to a daemon session. */
export function ptyWrite(sessionId: string, data: string): Promise<void> {
  return invoke("pty_write", { sessionId, data });
}

/** Resizes the remote PTY session. */
export function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { sessionId, cols, rows });
}

/** Kills a daemon PTY session. */
export function ptyKill(sessionId: string): Promise<void> {
  return invoke("pty_kill", { sessionId });
}

/**
 * Restarts the detached PTY daemon (Troubleshooting menu). Resolves once a fresh
 * daemon is reachable. Every running shell session is terminated, so the caller
 * should expect terminals to report exit.
 */
export function restartDaemon(): Promise<void> {
  return invoke("restart_daemon");
}

/** Returns the current contents of the server log file (empty if not yet created). */
export function readDaemonLog(): Promise<string> {
  return invoke<string>("read_daemon_log");
}

/** Lists persisted projects ordered for the project switcher. */
export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

/** Persists an existing git checkout as a project. */
export function addProject(path: string): Promise<Project> {
  return invoke<Project>("add_project", { path });
}

/** Clones a remote repository and persists it as a project. */
export function cloneProject(remoteUrl: string, intoDirectory: string): Promise<Project> {
  return invoke<Project>("clone_project", { remoteUrl, intoDirectory });
}

/** How the user authenticates to a remote SSH host. SSH agent is the default. */
export type RemoteAuthChoice =
  | { kind: "agent" }
  | { kind: "key"; path: string; passphrase: string | null }
  | { kind: "password"; password: string };

/** Credentials + target collected by the Add-project "Remote" tab. */
export interface RemoteConnectRequest {
  host: string;
  port: number;
  user: string;
  auth: RemoteAuthChoice;
  path: string;
}

/**
 * Connects to a remote host over SSH, verifies the path is a git repo on a
 * protocol-compatible `pragma-server`, and persists it as a project routed to
 * that host. All of the project's files/changes/terminals then run remotely.
 */
export function connectRemoteProject(request: RemoteConnectRequest): Promise<Project> {
  return invoke<Project>("connect_remote_project", { request });
}

/** Returns the default directory for native project pickers. */
export function getProjectsDirectory(): Promise<string> {
  return invoke<string>("get_projects_directory");
}

/** Loads optional `.pragma/scripts.json` for a project from its persisted root path. */
export function loadProjectScripts(projectId: string): Promise<ProjectScriptsConfig> {
  return invoke<ProjectScriptsConfig>("load_project_scripts", { projectId });
}

/**
 * Returns the persisted active selection (last active project + per-project
 * last active worktree) as opaque, frontend-owned JSON, or null on first
 * launch. The shape is owned by the frontend; Rust stores the string verbatim.
 */
export function getActiveSelection(): Promise<string | null> {
  return invoke<string | null>("get_active_selection");
}

/** Persists the active selection (opaque, frontend-owned JSON). */
export function setActiveSelection(value: string): Promise<void> {
  return invoke<void>("set_active_selection", { value });
}

/** Lists worktrees for a project. */
export function listWorktrees(projectId: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("list_worktrees", { projectId });
}

/** Client-local worktree recency row used by navigation surfaces. */
export interface WorktreeMru {
  worktreeId: string;
  lastUsedAt: number;
}

/** Records a worktree selection as most recently used. */
export function touchWorktreeMru(worktreeId: string): Promise<void> {
  return invoke("touch_worktree_mru", { worktreeId });
}

/** Lists a project's worktrees from most to least recently used. */
export function listWorktreeMru(projectId: string): Promise<WorktreeMru[]> {
  return invoke<WorktreeMru[]>("list_worktree_mru", { projectId });
}

/**
 * Returns, for each given worktree id, whether it belongs to an SSH-routed
 * remote project. Batched to avoid one IPC round trip per worktree.
 */
export function worktreesAreRemote(worktreeIds: string[]): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("worktrees_are_remote", { worktreeIds });
}

/** Opens a worktree in an editor launcher, or the system file explorer. */
export function openWorktree(worktreeId: string, editorId?: string | null): Promise<void> {
  return invoke("open_worktree", { worktreeId, editorId });
}

/** Creates a nested git worktree from a selected parent worktree. */
export function createWorktree(
  projectId: string,
  parentWorktreeId: string,
  branch: string,
  title?: string,
): Promise<Worktree> {
  return invoke<Worktree>("create_worktree", { projectId, parentWorktreeId, branch, title });
}

/** Reports whether a worktree has uncommitted, staged, or untracked changes. */
export function worktreeStatus(worktreeId: string): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("worktree_status", { worktreeId });
}

/** Updates the optional display title for a worktree; an empty string clears it. */
export function renameWorktree(worktreeId: string, title: string): Promise<Worktree> {
  return invoke<Worktree>("rename_worktree", { worktreeId, title: title.trim() || null });
}

/** Toggles the hidden flag on a worktree — the row persists, but the sidebar filters it out. */
export function setWorktreeHidden(worktreeId: string, hidden: boolean): Promise<Worktree> {
  return invoke<Worktree>("hide_worktree", { worktreeId, hidden });
}

/**
 * Removes a worktree from disk, optionally deletes its branch, terminates every
 * running shell in it, and deletes the row from SQLite. `force` lets the call
 * proceed even when the working copy is dirty (the UI is expected to have
 * surfaced a warning first).
 */
export function deleteWorktree(
  worktreeId: string,
  deleteBranch: boolean,
  force: boolean,
): Promise<void> {
  return invoke("delete_worktree", { worktreeId, deleteBranch, force });
}

/** Finds a favicon-like project icon. */
export function projectIcon(projectId: string): Promise<ProjectIcon | null> {
  return invoke<ProjectIcon | null>("project_icon", { projectId });
}

/** Lists persisted tabs (terminal and browser) for a project. */
export function listTabs(projectId: string): Promise<Tab[]> {
  return invoke<Tab[]>("list_tabs", { projectId });
}

/**
 * Creates a persisted tab. For terminal tabs the tab id is also the daemon
 * session id; for browser tabs `url` seeds the initial page; for editor/diff
 * tabs `filePath` (worktree-relative) and, for diffs, `diffSide` locate the
 * content.
 */
export function createTab(
  projectId: string,
  worktreeId: string,
  kind: TabKind = "terminal",
  title?: string,
  url?: string,
  filePath?: string | null,
  diffSide?: DiffSide | null,
  prNumber?: number | null,
): Promise<Tab> {
  return invoke<Tab>("create_tab", {
    projectId,
    worktreeId,
    kind,
    title,
    url,
    filePath,
    diffSide,
    // Only send `prNumber` for PR tabs; omitting it keeps the IPC arg shape
    // stable for the common non-PR case (an explicit null is still forwarded).
    ...(prNumber !== undefined && { prNumber }),
  });
}

/** Creates a persisted plugin web view tab. `pluginPayload` is JSON-encoded. */
export function createPluginWebViewTab(args: {
  projectId: string;
  worktreeId: string;
  title?: string;
  pluginId: string;
  pluginViewId: string;
  pluginPayload?: string | null;
  pluginDedupeKey?: string | null;
}): Promise<Tab> {
  return invoke<Tab>("create_plugin_webview_tab", args);
}

/** Closes a persisted tab. */
export function closeTab(tabId: string): Promise<void> {
  return invoke("close_tab", { tabId });
}

/** Renames a persisted tab. */
export function renameTab(tabId: string, title: string): Promise<Tab> {
  return invoke<Tab>("rename_tab", { tabId, title });
}

/**
 * Persists a shell-driven tab title (OSC 0/2) without touching the
 * `userRenamed` flag. The reducer is responsible for refusing to apply
 * the update when the user has explicitly renamed the tab.
 */
export function setTabTitle(tabId: string, title: string): Promise<Tab> {
  return invoke<Tab>("set_tab_title", { tabId, title });
}

/** Persists the current page URL for a browser tab (session restore). */
export function setTabUrl(tabId: string, url: string): Promise<Tab> {
  return invoke<Tab>("set_tab_url", { tabId, url });
}

/** A persisted per-worktree split layout; `layout` is the serialized split tree. */
export interface SplitLayout {
  worktreeId: string;
  layout: string;
}

/** Lists the persisted split-pane layouts for a project's worktrees. */
export function listSplits(projectId: string): Promise<SplitLayout[]> {
  return invoke<SplitLayout[]>("list_splits", { projectId });
}

/** Persists a worktree's split-pane layout (serialized split tree JSON). */
export function setSplitLayout(worktreeId: string, layout: string): Promise<void> {
  return invoke("set_split_layout", { worktreeId, layout });
}

/** Clears a worktree's split-pane layout when it collapses back to a single pane. */
export function clearSplitLayout(worktreeId: string): Promise<void> {
  return invoke("clear_split_layout", { worktreeId });
}

/** Lists a project's Kanban prompt cards. */
export function listKanbanCards(projectId: string): Promise<KanbanPromptCard[]> {
  return invoke<KanbanPromptCard[]>("list_kanban_cards", { projectId });
}

/** Creates a fresh draft card scoped to a project. */
export function createKanbanCard(
  projectId: string,
  branchName: string,
  prompt: string,
  agentId: string,
  modelId?: string | null,
): Promise<KanbanPromptCard> {
  return invoke<KanbanPromptCard>("create_kanban_card", {
    projectId,
    branchName,
    prompt,
    agentId,
    modelId: modelId ?? null,
  });
}

/** Persists every mutable field of a card (draft edits and status transitions). */
export function updateKanbanCard(card: KanbanPromptCard): Promise<KanbanPromptCard> {
  return invoke<KanbanPromptCard>("update_kanban_card", { card });
}

/** Moves a card to a different column (status only). */
export function moveKanbanCard(id: string, status: KanbanPromptStatus): Promise<KanbanPromptCard> {
  return invoke<KanbanPromptCard>("move_kanban_card", { id, status });
}

/** Deletes a Kanban card. */
export function deleteKanbanCard(id: string): Promise<void> {
  return invoke("delete_kanban_card", { id });
}

/**
 * Lists the immediate entries of a worktree-relative directory (`""` = root),
 * sorted directories-first then by name. Hidden `.git` and gitignored entries
 * are filtered out by the backend.
 */
export function listDirEntries(worktreeId: string, path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir_entries", { worktreeId, path });
}

/** Creates an empty file at a worktree-relative path; errors if it already exists. */
export function createFile(worktreeId: string, path: string): Promise<void> {
  return invoke("create_file", { worktreeId, path });
}

/** Creates a directory at a worktree-relative path; errors if it already exists. */
export function createFolder(worktreeId: string, path: string): Promise<void> {
  return invoke("create_folder", { worktreeId, path });
}

/** Reports whether a worktree-relative path exists on disk. */
export function pathExists(worktreeId: string, path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { worktreeId, path });
}

/** Reads a worktree-relative file, flagging binary/oversized content instead of returning bytes. */
export function readFile(worktreeId: string, path: string): Promise<FileContents> {
  return invoke<FileContents>("read_file", { worktreeId, path });
}

/** Overwrites a worktree-relative file with UTF-8 text (does not create parents). */
export function writeFile(worktreeId: string, path: string, contents: string): Promise<void> {
  return invoke("write_file", { worktreeId, path, contents });
}

/**
 * Renames (or moves) a worktree-relative entry. Both paths are resolved inside
 * the worktree; the source must exist and the destination must not.
 */
export function renameFile(worktreeId: string, fromPath: string, toPath: string): Promise<void> {
  return invoke("rename_file", { worktreeId, fromPath, toPath });
}

/**
 * Deletes a worktree-relative file or empty directory. The backend refuses to
 * recurse into non-empty directories.
 */
export function deleteFile(worktreeId: string, path: string): Promise<void> {
  return invoke("delete_file", { worktreeId, path });
}

/** Searches filenames and literal code across visible worktrees in one project. */
export function paletteSearch(
  projectId: string,
  worktreeId: string | null,
  searchId: string,
  query: string,
): Promise<PaletteSearchResponse> {
  return invoke<PaletteSearchResponse>("palette_search", {
    projectId,
    worktreeId,
    searchId,
    query,
  });
}

/** Cancels an in-flight host palette search. */
export function cancelPaletteSearch(projectId: string, searchId: string): Promise<void> {
  return invoke("cancel_palette_search", { projectId, searchId });
}

/**
 * Subscribes to live filesystem changes under a worktree. The server runs one
 * recursive watcher per worktree and streams each {@link FileChange} (worktree-
 * relative POSIX path, `.git` filtered out) through a Tauri channel. Resolves
 * with the channel so callers can detach (`channel.onmessage = noop`) when they
 * unmount — Tauri has no explicit channel-close API.
 */
export function watchWorktreeFiles(
  worktreeId: string,
  onChange: (change: FileChange) => void,
): Promise<Channel<FileChange>> {
  const channel = new Channel<FileChange>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
  channel.onmessage = onChange;
  return invoke<void>("watch_worktree_files", { worktreeId, onEvent: channel }).then(() => channel);
}

/**
 * Lists committed (base branch → HEAD), staged (HEAD → index), and unstaged
 * (index → working tree) changes for a worktree.
 */
export function worktreeChanges(worktreeId: string): Promise<WorktreeChanges> {
  return invoke<WorktreeChanges>("worktree_changes", { worktreeId });
}

/**
 * Reports, per worktree, whether it is fully merged & clean (HEAD already
 * contained by the parent branch, nothing staged/unstaged/untracked). A cheap, compact
 * alternative to {@link worktreeChanges} for the sidebar's merge-status poll: one
 * IPC call returns a `{ [worktreeId]: merged }` map instead of full file lists
 * per worktree, so polling many worktrees doesn't flood the UI thread.
 */
export function worktreesMergedStatus(worktreeIds: string[]): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("worktrees_merged_status", { worktreeIds });
}

/** Loads the old/new text for one changed file on the given diff side. */
export function fileDiff(
  worktreeId: string,
  path: string,
  side: DiffSide,
  oldPath?: string | null,
): Promise<FileDiff> {
  return invoke<FileDiff>("file_diff", { worktreeId, path, side, oldPath });
}

/** Discards one unstaged change, reverting the working-tree file to match the index. */
export function discardUnstagedFile(
  worktreeId: string,
  path: string,
  status: ChangeStatus,
  oldPath?: string | null,
): Promise<void> {
  return invoke("discard_unstaged_file", { worktreeId, path, status, oldPath });
}

/** Discards every unstaged change in the worktree (restores tracked, removes untracked). */
export function discardAllUnstaged(worktreeId: string): Promise<void> {
  return invoke("discard_all_unstaged", { worktreeId });
}

/** Stages a single worktree-relative change into the index (`git add`). */
export function stageFile(worktreeId: string, path: string): Promise<void> {
  return invoke("stage_file", { worktreeId, path });
}

/** Stages every change in the worktree into the index (`git add -A`). */
export function stageAll(worktreeId: string): Promise<void> {
  return invoke("stage_all", { worktreeId });
}

/** Unstages a single change from the index, leaving the working tree untouched. */
export function unstageFile(
  worktreeId: string,
  path: string,
  oldPath?: string | null,
): Promise<void> {
  return invoke("unstage_file", { worktreeId, path, oldPath });
}

/** Unstages every staged change in the worktree, resetting the index to HEAD. */
export function unstageAll(worktreeId: string): Promise<void> {
  return invoke("unstage_all", { worktreeId });
}

/**
 * Creates a commit from the worktree's staged changes using the given message
 * (`git commit -m <msg>`). The backend trims and rejects empty messages.
 */
export function commitStaged(worktreeId: string, message: string): Promise<void> {
  return invoke("commit_staged", { worktreeId, message });
}

/** Merges a clean child worktree branch into its clean parent worktree. */
export function mergeWorktreeToParent(worktreeId: string): Promise<void> {
  return invoke("merge_worktree_to_parent", { worktreeId });
}

/**
 * Reports GitHub auth state: whether a token is stored, whether the `gh` CLI is
 * an option, the signed-in user (best-effort), and whether setup was skipped.
 * Drives the setup-modal gate and the Pull Request subtab's logged-out state.
 */
export function githubAuthStatus(): Promise<GitHubAuthStatus> {
  return invoke<GitHubAuthStatus>("github_auth_status");
}

/** Returns the stored GitHub token for the Octokit client, or null. */
export function githubToken(): Promise<string | null> {
  return invoke<string | null>("github_token");
}

/** Clears the stored GitHub token (sign out). */
export function githubSignOut(): Promise<void> {
  return invoke("github_sign_out");
}

/** Persists the "user skipped GitHub setup" flag so the modal never returns. */
export function setGithubSetupDismissed(dismissed: boolean): Promise<void> {
  return invoke("set_github_setup_dismissed", { dismissed });
}

/** Adopts the `gh` CLI's token into the backend's on-disk 0600 token file and returns the user. */
export function githubUseCliToken(): Promise<GitHubUser> {
  return invoke<GitHubUser>("github_use_cli_token");
}

/** The codes the device-flow UI shows the user, plus the opaque `deviceCode` to poll on. */
export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

/**
 * Starts the OAuth Device Flow: requests a device + user code and opens the
 * verification page in the browser. Resolves with the codes to display and poll.
 */
export function githubStartDeviceFlow(): Promise<DeviceFlowStart> {
  return invoke<DeviceFlowStart>("github_start_device_flow");
}

/**
 * Polls the token endpoint until the user authorizes the device code, stores the
 * token in the backend's on-disk 0600 token file, and resolves with the
 * authenticated user. Rejects if the flow is denied, expires, or times out.
 */
export function githubPollDeviceFlow(deviceCode: string, interval: number): Promise<GitHubUser> {
  return invoke<GitHubUser>("github_poll_device_flow", { deviceCode, interval });
}

/** Parses a worktree's `origin` remote into owner/repo + default/head branch. */
export function githubRepoRef(worktreeId: string): Promise<GitHubRepoRef> {
  return invoke<GitHubRepoRef>("github_repo_ref", { worktreeId });
}

/** The default PR title for a worktree (its branch's last commit subject). */
export function githubDefaultPrTitle(worktreeId: string): Promise<string> {
  return invoke<string>("github_default_pr_title", { worktreeId });
}

/** Fetches `origin` and returns the branch's ahead/behind vs upstream (create pre-flight). */
export function githubFetchAndSync(worktreeId: string): Promise<BranchSyncStatus> {
  return invoke<BranchSyncStatus>("github_fetch_and_sync", { worktreeId });
}

/** Pushes the worktree's branch to `origin` (`git push -u origin <branch>`). */
export function githubPushBranch(worktreeId: string): Promise<void> {
  return invoke("github_push_branch", { worktreeId });
}

/** Loads the local `base...HEAD` diff for one PR file (review tab). */
export function githubPrFileDiff(
  worktreeId: string,
  base: string,
  path: string,
  oldPath?: string | null,
): Promise<FileDiff> {
  return invoke<FileDiff>("github_pr_file_diff", { worktreeId, base, path, oldPath });
}

/** Deletes the worktree's branch on `origin` (post-merge cleanup). */
export function githubDeleteRemoteBranch(worktreeId: string): Promise<void> {
  return invoke("github_delete_remote_branch", { worktreeId });
}

/** Logical pixel bounds (relative to the window) for a browser webview overlay. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page metadata pushed from a browser webview as it navigates. */
export interface BrowserMeta {
  tabId: string;
  title?: string;
  url?: string;
}

/** Creates the native browser webview for a tab, positioned over its placeholder. */
export function browserCreate(tabId: string, url: string, bounds: BrowserBounds): Promise<void> {
  return invoke("browser_create", { tabId, url, ...bounds });
}

/**
 * Outer frame height (logical px) of the window. Combined with the webview's
 * `window.innerHeight` to recover the title-bar inset (see BrowserView).
 */
export function browserFrameHeight(): Promise<number> {
  return invoke<number>("browser_frame_height");
}

/** Repositions/resizes a browser webview to track its placeholder. */
export function browserSetBounds(tabId: string, bounds: BrowserBounds): Promise<void> {
  return invoke("browser_set_bounds", { tabId, ...bounds });
}

/** Shows or hides a browser webview as its tab gains or loses focus. */
export function browserSetVisible(tabId: string, visible: boolean): Promise<void> {
  return invoke("browser_set_visible", { tabId, visible });
}

/** Moves keyboard focus to a browser webview when its pane is focused. */
export function browserFocus(tabId: string): Promise<void> {
  return invoke("browser_focus", { tabId });
}

/** Navigates a browser webview to a new URL (address-bar submit). */
export function browserNavigate(tabId: string, url: string): Promise<void> {
  return invoke("browser_navigate", { tabId, url });
}

/** Navigates back in a browser webview's history. */
export function browserBack(tabId: string): Promise<void> {
  return invoke("browser_back", { tabId });
}

/** Navigates forward in a browser webview's history. */
export function browserForward(tabId: string): Promise<void> {
  return invoke("browser_forward", { tabId });
}

/** Reloads the page in a browser webview. */
export function browserReload(tabId: string): Promise<void> {
  return invoke("browser_reload", { tabId });
}

/** Opens the native dev tools inspector for a browser webview (separate window). */
export function browserDevtools(tabId: string): Promise<void> {
  return invoke("browser_devtools", { tabId });
}

/** Clears cookies, cache, and storage for a browser webview. */
export function browserClearData(tabId: string): Promise<void> {
  return invoke("browser_clear_data", { tabId });
}

/** Opens a URL in the user's default system browser. */
export function browserOpenExternal(url: string): Promise<void> {
  return invoke("browser_open_external", { url });
}

/** Destroys the native webview backing a browser tab. */
export function browserClose(tabId: string): Promise<void> {
  return invoke("browser_close", { tabId });
}

/**
 * Screenshots the given physical screen rectangle and saves it via a native save
 * dialog. Resolves with the saved path, or null if the user cancelled.
 */
export function browserScreenshot(bounds: BrowserBounds): Promise<string | null> {
  return invoke<string | null>("browser_screenshot", { ...bounds });
}

/**
 * Captures the given physical screen rectangle and resolves with a
 * `data:image/png;base64,...` URL. Used to paint a still of the live page while
 * an HTML overlay covers a browser pane; capture before hiding the webview.
 */
export function browserSnapshot(bounds: BrowserBounds): Promise<string> {
  return invoke<string>("browser_snapshot", { ...bounds });
}

/** Subscribes to per-tab page metadata (title/url) from browser webviews. */
export function onBrowserMeta(handler: (meta: BrowserMeta) => void): Promise<UnlistenFn> {
  return listen<BrowserMeta>("browser-meta", (event) => handler(event.payload));
}

/** Payload sent by a browser webview when the user interacts with its content. */
export interface BrowserFocusRequest {
  tabId: string;
}

/** Subscribes to browser webviews requesting split-pane focus on interaction. */
export function onBrowserFocusRequest(
  handler: (request: BrowserFocusRequest) => void,
): Promise<UnlistenFn> {
  return listen<BrowserFocusRequest>("browser-focus-request", (event) => handler(event.payload));
}

/** A native menubar action forwarded to the workspace shell. */
export type MenuAction =
  | "tabs.new-terminal"
  | "tabs.close-active"
  | "workspace.open-command-palette"
  | "workspace.open-command-mode"
  | "troubleshooting.restart-daemon"
  | "troubleshooting.open-daemon-logs";

/** Subscribes to native menubar actions. */
export function onMenuAction(handler: (action: MenuAction) => void): Promise<UnlistenFn> {
  return listen<MenuAction>("pragma:menu", (event) => handler(event.payload));
}

/** Subscribes to incoming `pragma://` deep links; the payload is the raw URL. */
export function onDeepLink(handler: (url: string) => void): Promise<UnlistenFn> {
  return listen<string>("pragma:deep-link", (event) => handler(event.payload));
}

/**
 * Drains the deep link the app was launched with, if any. Returns the raw URL
 * once (clearing it) so a cold-start `pragma://` link delivered before the live
 * {@link onDeepLink} listener attached is still handled exactly one time.
 */
export function takePendingDeepLink(): Promise<string | null> {
  return invoke<string | null>("take_pending_deep_link");
}

/** Opens the native directory picker; resolves to the chosen path, or null if cancelled. */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === "string" ? selected : null;
}

/** Returns the runtime platform name used to pick keybinding chords ("mac" or "linux"). */
export function getPlatform(): Promise<"mac" | "linux"> {
  return invoke<"mac" | "linux">("platform_name");
}

/** Loads the user keybindings config, writing the default file first if it is missing. */
export function loadKeybindings(): Promise<KeybindingsConfig> {
  return invoke<KeybindingsConfig>("load_keybindings");
}

/** Saves a keybindings config back to `~/.pragma/keybindings.json`. */
export function saveKeybindings(config: KeybindingsConfig): Promise<void> {
  return invoke("save_keybindings", { config });
}

// ---------------------------------------------------------------------------
// AI (pi sidecar)
// ---------------------------------------------------------------------------

/** Whether AI features can run, plus which providers are signed in. */
export interface AiStatus {
  available: boolean;
  signedIn: string[];
}

/** One authorization method shown on the AI setup screen. */
export interface AiAuthMethod {
  provider: string;
  label: string;
  kind: "oauth" | "api-key";
  featured: boolean;
}

/** An event streamed from the `pragma-ai` sidecar during an OAuth login. */
export type AiLoginEvent =
  | { type: "auth"; url: string; instructions?: string }
  | {
      type: "device-code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string }
  | { type: "prompt"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: "select"; message: string; options: Array<{ id: string; label: string }> }
  | { type: "manual-code"; message: string }
  | { type: "result"; provider: string }
  | { type: "error"; code?: string; error: string }
  | { type: "log"; line: string };

/** Reports whether at least one authenticated provider exposes a usable model. */
export function aiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_status");
}

/** Every authorization method to present on the AI setup screen. */
export function aiAuthMethods(): Promise<AiAuthMethod[]> {
  return invoke<AiAuthMethod[]>("ai_auth_methods");
}

/** Stores an API key for a provider, returning the refreshed status. */
export function aiSetApiKey(provider: string, apiKey: string): Promise<AiStatus> {
  return invoke<AiStatus>("ai_set_api_key", { provider, apiKey });
}

/** Removes all stored credentials for a provider, returning the refreshed status. */
export function aiLogout(provider: string): Promise<AiStatus> {
  return invoke<AiStatus>("ai_logout", { provider });
}

/** Whether the user has dismissed AI setup. */
export function aiSetupDismissed(): Promise<boolean> {
  return invoke<boolean>("ai_setup_dismissed");
}

/** Persists the "user skipped AI setup" flag so the modal never returns. */
export function setAiSetupDismissed(dismissed: boolean): Promise<void> {
  return invoke("set_ai_setup_dismissed", { dismissed });
}

/** Generates a commit message from a worktree's staged changes (quick model). */
export function aiGenerateCommitMessage(worktreeId: string): Promise<string> {
  return invoke<string>("ai_generate_commit_message", { worktreeId });
}

/** AI-generated pull request title and markdown body. */
export interface AiPullRequestDraft {
  title: string;
  body: string;
}

/** Result of committing all changes and generating a PR draft. */
export interface AiCommitAndPullRequestDraft extends AiPullRequestDraft {
  commitCount: number;
}

/** Generates a pull request title/body from branch commits (standard model). */
export function aiGeneratePullRequestDraft(worktreeId: string): Promise<AiPullRequestDraft> {
  return invoke<AiPullRequestDraft>("ai_generate_pull_request_draft", { worktreeId });
}

/** Uses a standard model to commit all changes, then draft a pull request. */
export function aiCommitAllAndGeneratePullRequestDraft(
  worktreeId: string,
): Promise<AiCommitAndPullRequestDraft> {
  return invoke<AiCommitAndPullRequestDraft>("ai_commit_all_and_generate_pull_request_draft", {
    worktreeId,
  });
}

/**
 * Starts an interactive OAuth login, streaming events through the returned
 * channel. Answer prompts with {@link aiLoginRespond} and abort with
 * {@link aiLoginCancel}, both keyed by the same `id`.
 */
export function aiLogin(
  id: string,
  provider: string,
  onEvent: (event: AiLoginEvent) => void,
): Promise<void> {
  const channel = new Channel<AiLoginEvent>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
  channel.onmessage = onEvent;
  return invoke<void>("ai_login", { id, provider, onEvent: channel });
}

/** Answers a pending interactive login prompt (or cancels it). */
export function aiLoginRespond(
  id: string,
  value: string | null,
  cancelled: boolean,
): Promise<void> {
  return invoke("ai_login_respond", { id, value, cancelled });
}

/** Aborts an in-flight login and drops its session. */
export function aiLoginCancel(id: string): Promise<void> {
  return invoke("ai_login_cancel", { id });
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** Resolved metadata for a plugin directory, read from its `package.json`. */
export interface PluginManifest {
  name: string;
  version: string;
  /** Absolute path of the plugin directory. */
  dir: string;
  /** Absolute path of the bundle file `main` points at. */
  mainPath: string;
  /** Bundle mtime in ms since the epoch (dev hot-reload polling), if known. */
  modifiedMs: number | null;
}

/** One `.pragma/config.json` plugin entry: a manifest or a per-entry error. */
export interface PluginEntryResult {
  /** The original `path` specifier from the config file. */
  specifier: string;
  /** Which config file declared this entry. */
  scope: "bundled" | "global" | "project";
  /** Project root path for `scope: "project"` entries. */
  projectPath: string | null;
  /** The entry's `config` object, validated by the plugin's zod schema. */
  config: Record<string, unknown> | null;
  manifest: PluginManifest | null;
  error: string | null;
}

/**
 * Reads plugin entries from `~/.pragma/config.json` plus the given project's
 * `.pragma/config.json`, in declaration order (global first). Entries that
 * fail to resolve are returned with `error` set — never silently skipped.
 */
export function readPluginManifests(projectPath: string | null): Promise<PluginEntryResult[]> {
  return invoke<PluginEntryResult[]>("read_plugin_manifests", { projectPath });
}

/** Reads the JavaScript source of a resolved plugin bundle file. */
export function readPluginBundle(mainPath: string): Promise<string> {
  return invoke<string>("read_plugin_bundle", { mainPath });
}

/** Connection details for the local Pragma HTTP gateway. */
export interface GatewayConnectionInfo {
  /** Gateway HTTP origin, e.g. `http://127.0.0.1:49152`. */
  baseUrl: string;
  /** Bearer token expected by the gateway. */
  token: string;
}

/** Ensures the local HTTP gateway is running and returns its base URL + token. */
export function gatewayConnectionInfo(): Promise<GatewayConnectionInfo> {
  return invoke<GatewayConnectionInfo>("gateway_connection_info");
}

/**
 * Regenerates the gateway bearer token and returns the fresh connection info.
 * Paired devices disconnect until they re-pair with the new token.
 */
export function regenerateGatewayToken(): Promise<GatewayConnectionInfo> {
  return invoke<GatewayConnectionInfo>("regenerate_gateway_token");
}

/** Remote-access tunnel lifecycle state (mirrors the Rust `TunnelStatus`). */
export type TunnelStatus =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "active"; value: string }
  | { state: "error"; value: string };

/**
 * Starts the remote-access tunnel exposing the local gateway. Returns the
 * initial status (usually `starting`); poll {@link tunnelStatus} until `active`.
 */
export function tunnelStart(): Promise<TunnelStatus> {
  return invoke<TunnelStatus>("tunnel_start");
}

/** Stops the remote-access tunnel; paired devices disconnect. */
export function tunnelStop(): Promise<void> {
  return invoke<void>("tunnel_stop");
}

/** Returns the current remote-access tunnel status. */
export function tunnelStatus(): Promise<TunnelStatus> {
  return invoke<TunnelStatus>("tunnel_status");
}

/** Reads one plugin-owned durable storage value as an opaque JSON string. */
export function pluginStorageGet(pluginId: string, key: string): Promise<string | null> {
  return invoke<string | null>("plugin_storage_get", { pluginId, key });
}

/** Writes one plugin-owned durable storage value as an opaque JSON string. */
export function pluginStorageSet(pluginId: string, key: string, value: string): Promise<void> {
  return invoke("plugin_storage_set", { pluginId, key, value });
}
