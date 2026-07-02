import type { DirEntry, FileContents } from "@pragma/constants";

export type { DirEntry, FileContents };

export interface WorktreePathRequest {
  root: string;
  path: string;
}

export interface WriteFileRequest extends WorktreePathRequest {
  contents: string;
}

export interface RenameRequest {
  root: string;
  from: string;
  to: string;
}
