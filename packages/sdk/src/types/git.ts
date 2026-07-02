import type {
  BranchSyncStatus,
  ChangeStatus,
  DiffSide,
  FileDiff,
  WorktreeChanges,
} from "@pragma/constants";

export type { BranchSyncStatus, ChangeStatus, DiffSide, FileDiff, WorktreeChanges };

export interface MergedStatusItem {
  id: string;
  root: string;
  branch: string;
  parentBranch: string | null;
}

export interface GithubRepoInfo {
  remoteUrl: string;
  defaultBranch: string;
  headBranch: string;
}

// TODO: promote/codegen the remaining git request/response types from pragma-core.
export type GitPayload = Record<string, unknown>;
