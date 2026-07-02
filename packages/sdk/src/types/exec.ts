export interface ExecRunRequest {
  cwd: string;
  commands: string[];
  env?: Array<[string, string]>;
  maxConcurrent?: number;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  status: number | null;
  durationMs: number;
}
