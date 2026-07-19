// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { routes } from "./routes";
import type { Transport } from "./transport";
import type {
  BranchSyncStatus,
  FileDiff,
  GithubRepoInfo,
  GitPayload,
  MergedStatusItem,
  WorktreeChanges,
} from "./types/git";

/** Git RPC namespace. */
export class GitClient {
  constructor(private readonly transport: Transport) {}

  worktreeChanges(payload: {
    root: string;
    parentBranch?: string | null;
  }): Promise<WorktreeChanges> {
    return this.rpc("worktreeChanges", payload);
  }

  mergedStatus(payload: { items: MergedStatusItem[] }): Promise<Record<string, boolean>> {
    return this.rpc("mergedStatus", payload);
  }

  fileDiff(payload: GitPayload): Promise<FileDiff> {
    return this.rpc("fileDiff", payload);
  }

  discardUnstagedFile(payload: GitPayload): Promise<void> {
    return this.rpc("discardUnstagedFile", payload);
  }

  discardAllUnstaged(payload: { root: string }): Promise<void> {
    return this.rpc("discardAllUnstaged", payload);
  }

  stageFile(payload: { root: string; path: string }): Promise<void> {
    return this.rpc("stageFile", payload);
  }

  stageAll(payload: { root: string }): Promise<void> {
    return this.rpc("stageAll", payload);
  }

  unstageFile(payload: { root: string; path: string; oldPath?: string | null }): Promise<void> {
    return this.rpc("unstageFile", payload);
  }

  unstageAll(payload: { root: string }): Promise<void> {
    return this.rpc("unstageAll", payload);
  }

  commitStaged(payload: { root: string; message: string }): Promise<void> {
    return this.rpc("commitStaged", payload);
  }

  mergeWorktreeToParent(payload: GitPayload): Promise<void> {
    return this.rpc("mergeWorktreeToParent", payload);
  }

  prFileDiff(payload: GitPayload): Promise<FileDiff> {
    return this.rpc("prFileDiff", payload);
  }

  githubRepoInfo(payload: { root: string }): Promise<GithubRepoInfo> {
    return this.rpc("githubRepoInfo", payload);
  }

  githubDefaultPrTitle(payload: { root: string }): Promise<string> {
    return this.rpc("githubDefaultPrTitle", payload);
  }

  githubFetchAndSync(payload: { root: string }): Promise<BranchSyncStatus> {
    return this.rpc("githubFetchAndSync", payload);
  }

  githubPullBranch(payload: { root: string }): Promise<void> {
    return this.rpc("githubPullBranch", payload);
  }

  githubSyncBranch(payload: { root: string }): Promise<void> {
    return this.rpc("githubSyncBranch", payload);
  }

  githubPushBranch(payload: { root: string }): Promise<void> {
    return this.rpc("githubPushBranch", payload);
  }

  githubDeleteRemoteBranch(payload: { root: string }): Promise<void> {
    return this.rpc("githubDeleteRemoteBranch", payload);
  }

  ensurePragmaExcluded(payload: { projectRoot: string }): Promise<void> {
    return this.rpc("ensurePragmaExcluded", payload);
  }

  createWorktree(payload: { parentRoot: string; branch: string; path: string }): Promise<void> {
    return this.rpc("createWorktree", payload);
  }

  removeWorktree(payload: {
    repoRoot: string;
    worktreePath: string;
    force: boolean;
  }): Promise<void> {
    return this.rpc("removeWorktree", payload);
  }

  deleteBranch(payload: { repoRoot: string; branch: string }): Promise<void> {
    return this.rpc("deleteBranch", payload);
  }

  isDirty(payload: { root: string }): Promise<boolean> {
    return this.rpc("isDirty", payload);
  }

  private rpc<T>(op: string, payload: object): Promise<T> {
    return this.transport.request<T>(routes.rpc("git"), { body: { op, ...payload } });
  }
}
