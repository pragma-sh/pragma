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
  /**
   * Where output delivery starts, in absolute bytes since the session began.
   * `reset` means the requested cursor fell outside retained scrollback, so
   * the renderer must clear and rebuild from here rather than appending.
   */
  | { type: "replay"; sessionId: string; cursor: number; reset: boolean }
  | { type: "title"; sessionId: string; title: string }
  | { type: "exit"; sessionId: string; code: number | null }
  | { type: "echoMode"; sessionId: string; echo: boolean };

export interface StreamOptions {
  signal?: AbortSignal;
  /**
   * The attaching client's viewport. Sending it resizes the PTY grid; omit it
   * to observe a session without disturbing the size its interactive client
   * set. A client that holds a viewport lease should send its size here.
   */
  cols?: number;
  rows?: number;
  /**
   * Absolute output byte offset to resume from — the cursor of the last output
   * this client accepted. Omit on a first attach to receive the retained
   * scrollback. A cursor is only meaningful to the renderer that produced it:
   * a fresh renderer has no parser state to resume into.
   */
  cursor?: number;
}
