import type {
  AppInfo,
  ChangeStatus,
  DiffSide,
  DirEntry,
  FileContents,
  FileDiff,
  KeybindingsConfig,
  Project,
  ProjectIcon,
  Tab,
  TabKind,
  WorktreeChanges,
  Worktree,
  WorktreeStatus,
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

export type PtyEvent = { event: "output"; data: string } | { event: "exit"; code: number | null };

export type PtyEventHandler = (event: PtyEvent) => void;

/**
 * Spawns a daemon-backed PTY session and streams events through a Tauri channel.
 * Resolves with the channel so callers can detach (`channel.onmessage = noop`)
 * when the terminal is disposed — Tauri has no explicit channel-close API.
 */
export function ptySpawn(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  onEvent: PtyEventHandler,
): Promise<Channel<PtyEvent>> {
  const channel = new Channel<PtyEvent>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
  channel.onmessage = onEvent;
  return invoke<void>("pty_spawn", { sessionId, cwd, cols, rows, onEvent: channel }).then(
    () => channel,
  );
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
): Promise<Channel<PtyEvent>> {
  const channel = new Channel<PtyEvent>();
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

/** Returns the default directory for native project pickers. */
export function getProjectsDirectory(): Promise<string> {
  return invoke<string>("get_projects_directory");
}

/** Lists worktrees for a project. */
export function listWorktrees(projectId: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("list_worktrees", { projectId });
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
): Promise<Tab> {
  return invoke<Tab>("create_tab", { projectId, worktreeId, kind, title, url, filePath, diffSide });
}

/** Closes a persisted tab. */
export function closeTab(tabId: string): Promise<void> {
  return invoke("close_tab", { tabId });
}

/** Renames a persisted tab. */
export function renameTab(tabId: string, title: string): Promise<Tab> {
  return invoke<Tab>("rename_tab", { tabId, title });
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

/**
 * Lists committed (base branch → HEAD), staged (HEAD → index), and unstaged
 * (index → working tree) changes for a worktree.
 */
export function worktreeChanges(worktreeId: string): Promise<WorktreeChanges> {
  return invoke<WorktreeChanges>("worktree_changes", { worktreeId });
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
