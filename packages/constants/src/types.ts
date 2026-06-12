export interface Project {
  id: string;
  name: string;
  path: string;
  orderIndex: number;
  createdAt: string;
}

export interface Worktree {
  id: string;
  projectId: string;
  parentId?: string | null;
  branch: string;
  title?: string | null;
  path: string;
  isMain: number;
  createdAt: string;
}

export interface Tab {
  id: string;
  projectId: string;
  worktreeId: string;
  title?: string | null;
  orderIndex: number;
  createdAt: string;
}

export interface ProjectIcon {
  mime: string;
  dataBase64: string;
}
