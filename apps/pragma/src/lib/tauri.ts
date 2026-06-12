import type { Project, ProjectIcon, Tab, Worktree } from "@pragma/constants";
import { Channel, invoke } from "@tauri-apps/api/core";

export { type AppInfo } from "@pragma/constants";

export function getAppInfo() {
  return invoke<{ name: string; identifier: string; version: string }>("app_info");
}

export function ptySpawn(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  onEvent: (event: PtyEvent) => void,
) {
  const channel = new Channel<{ type: string; data?: string; code?: number; message?: string }>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  channel.onmessage = (msg) => {
    if (msg.type === "output" || msg.type === "scrollback") {
      onEvent({ type: "output", data: msg.data ?? "" });
    } else if (msg.type === "exit") {
      onEvent({ type: "exit", code: msg.code ?? null });
    } else if (msg.type === "error") {
      onEvent({ type: "error", message: msg.message ?? "unknown" });
    }
  };
  return invoke("pty_spawn", { sessionId: sessionId, cwd, cols, rows, onEvent: channel });
}

export function ptyAttach(
  sessionId: string,
  cols: number,
  rows: number,
  onEvent: (event: PtyEvent) => void,
) {
  const channel = new Channel<{ type: string; data?: string; code?: number; message?: string }>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  channel.onmessage = (msg) => {
    if (msg.type === "output" || msg.type === "scrollback") {
      onEvent({ type: "output", data: msg.data ?? "" });
    } else if (msg.type === "exit") {
      onEvent({ type: "exit", code: msg.code ?? null });
    } else if (msg.type === "error") {
      onEvent({ type: "error", message: msg.message ?? "unknown" });
    }
  };
  return invoke("pty_attach", { sessionId: sessionId, cols, rows, onEvent: channel });
}

export function ptyWrite(sessionId: string, data: string) {
  return invoke("pty_write", { sessionId: sessionId, data });
}

export function ptyResize(sessionId: string, cols: number, rows: number) {
  return invoke("pty_resize", { sessionId: sessionId, cols, rows });
}

export function ptyKill(sessionId: string) {
  return invoke("pty_kill", { sessionId: sessionId });
}

export function listProjects() {
  return invoke<Project[]>("list_projects");
}

export function addProject(path: string) {
  return invoke<Project>("add_project", { path });
}

export function cloneProject(remoteUrl: string, intoDirectory: string) {
  return invoke<Project>("clone_project", { remoteUrl: remoteUrl, intoDirectory: intoDirectory });
}

export function getProjectsDirectory() {
  return invoke<string | null>("get_projects_directory");
}

export function listWorktrees(projectId: string) {
  return invoke<Worktree[]>("list_worktrees", { projectId: projectId });
}

export function createWorktree(
  projectId: string,
  parentWorktreeId: string,
  branch: string,
  title?: string,
) {
  return invoke<Worktree>("create_worktree", {
    projectId: projectId,
    parentWorktreeId: parentWorktreeId,
    branch,
    title,
  });
}

export function getProjectIcon(projectId: string) {
  return invoke<ProjectIcon | null>("project_icon", { projectId: projectId });
}

export function listTabs(projectId: string) {
  return invoke<Tab[]>("list_tabs", { projectId: projectId });
}

export function createTab(
  id: string,
  projectId: string,
  worktreeId: string,
  orderIndex: number,
  title?: string,
) {
  return invoke<Tab>("create_tab", {
    id,
    projectId: projectId,
    worktreeId: worktreeId,
    title,
    orderIndex: orderIndex,
  });
}

export function deleteTab(id: string) {
  return invoke<void>("delete_tab", { id });
}

export type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };
