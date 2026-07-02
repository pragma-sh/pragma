export interface SpawnSessionRequest {
  cwd: string;
  cols?: number;
  rows?: number;
  worktreeId?: string;
}

export interface SpawnSessionResponse {
  sessionId: string;
  worktreeId: string;
  cwd: string;
}

export type SessionEvent =
  | { type: "output"; sessionId: string; dataBase64: string }
  | { type: "title"; sessionId: string; title: string }
  | { type: "exit"; sessionId: string; code: number | null }
  | { type: "echoMode"; sessionId: string; echo: boolean };

export interface StreamOptions {
  signal?: AbortSignal;
}
