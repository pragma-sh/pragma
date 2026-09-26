/**
 * Projects whose folder is not a git repository ("plain" projects).
 *
 * A plain project keeps a single root worktree — tabs, agent sessions and
 * statuses work exactly as they do on a git project's main worktree — but has
 * no worktrees, changes, or pull requests until the user initializes a
 * repository, which promotes the project in place.
 */

import { constants, type OtherSettings, type Project, type Worktree } from "@pragma-sh/constants";

import { readConfig, writeConfig } from "@/lib/tauri";

/** Window event that asks the sidebar to open the Add project dialog. */
export const CREATE_PROJECT_EVENT = "pragma:create-project";

const CONFIG_CHANGED_EVENT = "pragma:config-changed";

/** Whether a project is backed by a git repository. Omitted means yes. */
export function projectIsGit(project: Pick<Project, "isGit"> | null | undefined): boolean {
  return project?.isGit !== false;
}

/** Sidebar label for a project's main worktree: `main`, or `root` when it has no git. */
export function mainWorktreeLabel(project: Pick<Project, "isGit"> | null | undefined): string {
  return projectIsGit(project) ? "main" : constants.projects.nonGitRootLabel;
}

/** Display label for any worktree: the main one by project kind, others by title or branch. */
export function worktreeDisplayLabel(
  worktree: Pick<Worktree, "isMain" | "title" | "branch">,
  project: Pick<Project, "isGit"> | null | undefined,
): string {
  return worktree.isMain ? mainWorktreeLabel(project) : (worktree.title ?? worktree.branch);
}

/** Opens the Add project dialog from anywhere in the shell. */
export function requestAddProject(): void {
  window.dispatchEvent(new Event(CREATE_PROJECT_EVENT));
}

async function readGlobalConfig(): Promise<Record<string, unknown>> {
  const document = await readConfig("global");
  const parsed = JSON.parse(document.contents || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json root must be an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Whether adding a plain folder should warn first. Global-only
 * (`other.nonGitProjectWarning`); an unreadable config falls back to the
 * shipped default so a broken file never silently hides the warning.
 */
export async function nonGitWarningEnabled(): Promise<boolean> {
  try {
    const other = (await readGlobalConfig()).other as OtherSettings | undefined;
    const value = other?.nonGitProjectWarning;
    return typeof value === "boolean" ? value : constants.projects.nonGitWarning;
  } catch {
    return constants.projects.nonGitWarning;
  }
}

/** Persists "Don't show again" for the plain-folder warning into the global config. */
export async function disableNonGitWarning(): Promise<void> {
  const config = await readGlobalConfig();
  const other = (config.other ?? {}) as OtherSettings;
  const next = { ...config, other: { ...other, nonGitProjectWarning: false } };
  await writeConfig("global", `${JSON.stringify(next, null, 2)}\n`);
  window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
}
