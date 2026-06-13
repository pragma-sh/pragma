import type {
  AppInfo,
  KeybindingsConfig,
  Project,
  ProjectIcon,
  Tab,
  TabKind,
  Worktree,
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

/** Opens a worktree path in an editor launcher, or the system file explorer. */
export function openWorktree(path: string, editorId?: string | null): Promise<void> {
  return invoke("open_worktree", { path, editorId });
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
 * session id; for browser tabs `url` seeds the initial page.
 */
export function createTab(
  projectId: string,
  worktreeId: string,
  kind: TabKind = "terminal",
  title?: string,
  url?: string,
): Promise<Tab> {
  return invoke<Tab>("create_tab", { projectId, worktreeId, kind, title, url });
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

/** Subscribes to per-tab page metadata (title/url) from browser webviews. */
export function onBrowserMeta(handler: (meta: BrowserMeta) => void): Promise<UnlistenFn> {
  return listen<BrowserMeta>("browser-meta", (event) => handler(event.payload));
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
