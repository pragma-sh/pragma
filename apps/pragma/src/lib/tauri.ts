import type { AppInfo, Project, ProjectIcon, Tab, Worktree } from "@pragma/constants";
import { Channel, invoke } from "@tauri-apps/api/core";
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

/** Lists persisted terminal tabs for a project. */
export function listTabs(projectId: string): Promise<Tab[]> {
  return invoke<Tab[]>("list_tabs", { projectId });
}

/** Creates a persisted terminal tab; the tab id is also the daemon session id. */
export function createTab(projectId: string, worktreeId: string, title?: string): Promise<Tab> {
  return invoke<Tab>("create_tab", { projectId, worktreeId, title });
}

/** Closes a persisted terminal tab. */
export function closeTab(tabId: string): Promise<void> {
  return invoke("close_tab", { tabId });
}

/** Opens the native directory picker; resolves to the chosen path, or null if cancelled. */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === "string" ? selected : null;
}
