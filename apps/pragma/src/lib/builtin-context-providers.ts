import { CircleDot, FileText, Folder, GitPullRequest } from "lucide-react";

import type { DirEntry } from "@pragma-sh/constants";
import {
  type ContextItem,
  type ContextProviderDefinition,
  type ContextWorktree,
  ContextProviderNotice,
  defineContextProvider,
} from "@pragma-sh/plugin/catalog";

import {
  getIssueDetail,
  GitHubAuthError,
  type IssueDetail,
  type IssueListing,
  listRecentIssues,
} from "@/lib/github";
import { cancelPaletteSearch, githubRepoRef, listDirEntries, paletteSearch } from "@/lib/tauri";

/** `data` carried by a built-in GitHub context item. */
interface IssueItemData {
  number: number;
}

/** `data` carried by a built-in file or folder item. */
interface FileItemData {
  isDir: boolean;
}

/**
 * Worktree files, found by the host's command-palette filename search. A bare
 * `@` lists the worktree root instead, so the picker never opens empty.
 */
const filesProvider = defineContextProvider<unknown, FileItemData>({
  id: "files",
  title: "Files",
  icon: FileText,
  async search({ query, project, worktree, signal }) {
    if (!project || !worktree) return [];
    if (!query.trim()) return rootEntries(worktree);
    const searchId = crypto.randomUUID();
    const cancel = () => void cancelPaletteSearch(project.id, searchId).catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const { matches } = await paletteSearch(project.id, worktree.id, searchId, query);
      return matches
        .filter((match) => match.kind === "file" && match.worktreeId === worktree.id)
        .map((match) => fileItem(match.path, false));
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
  resolve: ({ item }) =>
    item.data?.isDir
      ? `The user referenced the folder \`${item.displayName}\` (relative to the worktree root). Explore it before acting on the request.`
      : `The user referenced the file \`${item.displayName}\` (relative to the worktree root). Read it before acting on the request.`,
});

/** The worktree root's visible entries: folders first, then files, dotfiles skipped. */
async function rootEntries(worktree: ContextWorktree): Promise<ContextItem<FileItemData>[]> {
  const entries = (await listDirEntries(worktree.id, "")).filter(
    (entry) => !entry.name.startsWith("."),
  );
  return entries
    .toSorted((a, b) => byKind(a) - byKind(b) || a.name.localeCompare(b.name))
    .map((entry) => fileItem(entry.path, entry.isDir));
}

/** Sort key that puts folders before files. */
function byKind(entry: DirEntry): number {
  return entry.isDir ? 0 : 1;
}

function fileItem(path: string, isDir: boolean): ContextItem<FileItemData> {
  return {
    id: path,
    displayName: isDir ? `${path}/` : path,
    ...(isDir ? { icon: Folder } : {}),
    data: { isDir },
  };
}

/** Shown by both GitHub providers when no token is stored; the picker shows it once. */
const GITHUB_SIGN_IN_NOTICE =
  "Sign in to GitHub (Settings → GitHub) to see issues and pull requests.";

/** Builds the provider for one kind of GitHub item: issues or pull requests. */
function githubProvider(
  kind: IssueListing["kind"],
): ContextProviderDefinition<unknown, IssueItemData> {
  return defineContextProvider<unknown, IssueItemData>({
    id: kind === "issue" ? "github-issues" : "github-pulls",
    title: kind === "issue" ? "GitHub issues" : "Pull requests",
    icon: kind === "issue" ? CircleDot : GitPullRequest,
    async search({ query, worktree }) {
      if (!worktree) return [];
      try {
        return await searchIssues(worktree, kind, query);
      } catch (cause) {
        if (cause instanceof GitHubAuthError)
          throw new ContextProviderNotice(GITHUB_SIGN_IN_NOTICE);
        // Not a GitHub repository (or GitHub is unreachable): offer nothing.
        return [];
      }
    },
    async resolve({ item, worktree }) {
      const number = item.data?.number;
      if (!worktree || number === undefined) return "";
      const detail = await getIssueDetail(await githubRepoRef(worktree.id), number);
      return formatIssueContext(detail);
    },
  });
}

async function searchIssues(
  worktree: ContextWorktree,
  kind: IssueListing["kind"],
  query: string,
): Promise<ContextItem<IssueItemData>[]> {
  const repo = await githubRepoRef(worktree.id);
  const listed = (await listRecentIssues(repo)).filter((issue) => issue.kind === kind);
  // An open item older than the recent listing is still reachable by typing its
  // number exactly. Closed items are never offered.
  const exact = /^#?(\d+)$/.exec(query.trim());
  const wanted = exact ? Number(exact[1]) : null;
  if (wanted !== null && !listed.some((issue) => issue.number === wanted)) {
    const detail = await getIssueDetail(repo, wanted).catch(() => null);
    if (detail?.kind === kind && detail.state === "open") listed.unshift(detail);
  }
  return listed.map(issueItem);
}

function issueItem(issue: IssueListing): ContextItem<IssueItemData> {
  return {
    id: String(issue.number),
    displayName: `#${issue.number}`,
    searchText: `#${issue.number} ${issue.title}`,
    description: issue.title,
    data: { number: issue.number },
  };
}

/** The text an agent receives for a referenced GitHub issue or pull request. */
export function formatIssueContext(detail: IssueDetail): string {
  const noun = detail.kind === "pull" ? "pull request" : "issue";
  const cli = detail.kind === "pull" ? "gh pr view" : "gh issue view";
  return [
    `GitHub ${noun} #${detail.number}: ${detail.title} (${detail.state})`,
    ...(detail.author ? [`Author: @${detail.author}`] : []),
    `Link: ${detail.htmlUrl}`,
    `Open the link (or run \`${cli} ${detail.number} --comments\`) for the discussion and further details.`,
    "",
    detail.body.trim() || "(no description)",
  ].join("\n");
}

/**
 * Context providers Pragma ships, listed ahead of any plugin's. Issues and
 * pull requests come before files: they show even for a bare `@`.
 */
export const BUILTIN_CONTEXT_PROVIDERS: readonly ContextProviderDefinition[] = [
  githubProvider("issue"),
  githubProvider("pull"),
  filesProvider,
];
