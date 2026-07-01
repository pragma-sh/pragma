import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

const DEFAULT_PRAGMA_CLI_EXECUTABLE = "pragma-cli";

/** Status attention types accepted by `pragma-cli agent report attention --kind`. */
export type AttentionKind = "question" | "command";

/** Common options used to spawn the `pragma-cli` CLI. */
export interface PragmaAgentSpawnOptions {
  /** Path or executable name for the CLI. Defaults to `pragma-cli`. */
  executable?: string;
  /** Working directory for the spawned CLI process. */
  cwd?: string | URL;
  /** Environment variables merged over `process.env` for the spawned CLI process. */
  env?: Record<string, string | undefined>;
  /** Abort signal used to cancel the spawned CLI process. */
  signal?: AbortSignal;
}

/** Required global flags for every `pragma-cli` command. */
export interface PragmaAgentCommandOptions extends PragmaAgentSpawnOptions {
  /** Stable agent id from the Pragma agent config. Maps to `--agent`. */
  agent: string;
}

/** Options for `pragma-cli agent report started`. */
export type ReportStartedOptions = PragmaAgentCommandOptions;

/** Options for `pragma-cli agent report stopped`. */
export interface ReportStoppedOptions extends PragmaAgentCommandOptions {
  /** Override for `PRAGMA_WORKTREE_ID`. Maps to `--worktree-id`. */
  worktreeId?: string;
}

/** Options for `pragma-cli agent report attention`. */
export interface ReportAttentionOptions extends PragmaAgentCommandOptions {
  /** Attention reason. Maps to `--kind`. */
  kind: AttentionKind;
}

/** Options for `pragma-cli agent report cleared`. */
export interface ReportClearedOptions extends PragmaAgentCommandOptions {
  /** Override for `PRAGMA_WORKTREE_ID`. Maps to `--worktree-id`. */
  worktreeId?: string;
}

/** Result returned after a CLI command exits successfully. */
export interface PragmaCliResult {
  /** Executable used for the spawned CLI process. */
  executable: string;
  /** Arguments passed to the executable, excluding the executable itself. */
  args: readonly string[];
  /** Numeric process exit code. Successful helpers only resolve with `0`. */
  exitCode: number;
  /** Captured standard output decoded as UTF-8. */
  stdout: string;
  /** Captured standard error decoded as UTF-8. */
  stderr: string;
}

/** Error thrown when a wrapped CLI command fails to spawn or exits unsuccessfully. */
export class PragmaCliError extends Error {
  /** Executable used for the failed CLI process. */
  readonly executable: string;
  /** Arguments passed to the executable, excluding the executable itself. */
  readonly args: readonly string[];
  /** Numeric process exit code, or `null` when the process failed before exiting. */
  readonly exitCode: number | null;
  /** Captured standard output decoded as UTF-8. */
  readonly stdout: string;
  /** Captured standard error decoded as UTF-8. */
  readonly stderr: string;
  /** Original process spawn error, when the CLI failed before exit. */
  readonly cause?: unknown;

  constructor(
    message: string,
    details: {
      executable: string;
      args: readonly string[];
      exitCode: number | null;
      stdout: string;
      stderr: string;
    },
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PragmaCliError";
    this.executable = details.executable;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.cause = cause;
  }
}

/**
 * Runs `pragma-cli agent report --agent <id> started` for the current Pragma terminal tab.
 *
 * The spawned CLI reads `PRAGMA_DAEMON_SOCKET`, `PRAGMA_TAB_ID`, and
 * `PRAGMA_WORKTREE_ID` from the provided environment or the current process
 * environment.
 */
export function reportStarted(options: ReportStartedOptions): Promise<PragmaCliResult> {
  return runPragmaAgent(
    ["agent", "report", "--agent", requiredFlag("agent", options.agent), "started"],
    options,
  );
}

/**
 * Runs `pragma-cli agent report --agent <id> stopped` for the current Pragma terminal tab.
 *
 * Pass `worktreeId` to emit `--worktree-id`; otherwise the CLI falls back to
 * `PRAGMA_WORKTREE_ID`.
 */
export function reportStopped(options: ReportStoppedOptions): Promise<PragmaCliResult> {
  return runPragmaAgent(
    [
      "agent",
      "report",
      "--agent",
      requiredFlag("agent", options.agent),
      "stopped",
      ...optionalFlag("--worktree-id", options.worktreeId),
    ],
    options,
  );
}

/**
 * Runs `pragma-cli agent report --agent <id> attention --kind <kind>` for the current Pragma terminal tab.
 *
 * Use this when an external agent needs the Pragma UI to show that the tab is
 * waiting for a question or command confirmation.
 */
export function reportAttention(options: ReportAttentionOptions): Promise<PragmaCliResult> {
  return runPragmaAgent(
    [
      "agent",
      "report",
      "--agent",
      requiredFlag("agent", options.agent),
      "attention",
      "--kind",
      options.kind,
    ],
    options,
  );
}

/**
 * Runs `pragma-cli agent report --agent <id> cleared` for the current Pragma terminal tab.
 *
 * Unlike {@link reportStopped} (which leaves a green "done" indicator), this
 * removes the agent's indicator entirely. Use it when the agent process exits
 * rather than when it finishes a turn. Pass `worktreeId` to emit
 * `--worktree-id`; otherwise the CLI falls back to `PRAGMA_WORKTREE_ID`.
 */
export function reportCleared(options: ReportClearedOptions): Promise<PragmaCliResult> {
  return runPragmaAgent(
    [
      "agent",
      "report",
      "--agent",
      requiredFlag("agent", options.agent),
      "cleared",
      ...optionalFlag("--worktree-id", options.worktreeId),
    ],
    options,
  );
}

function runPragmaAgent(
  args: readonly string[],
  options: PragmaAgentSpawnOptions,
): Promise<PragmaCliResult> {
  const env = { ...process.env, ...options.env };
  const executable = options.executable ?? env.PRAGMA_CLI ?? DEFAULT_PRAGMA_CLI_EXECUTABLE;
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error: Error) => {
      const result = cliResult(executable, args, 1, stdoutChunks, stderrChunks);
      reject(
        new PragmaCliError(
          `failed to run ${executable}: ${error.message}`,
          { ...result, exitCode: null },
          error,
        ),
      );
    });

    child.on("close", (exitCode: number | null) => {
      const result = cliResult(executable, args, exitCode ?? 1, stdoutChunks, stderrChunks);
      if (result.exitCode === 0) {
        resolve(result);
        return;
      }
      reject(new PragmaCliError(`${executable} exited with code ${result.exitCode}`, result));
    });
  });
}

function requiredFlag(name: string, value: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function optionalFlag(flag: string, value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return [flag, requiredFlag(flag, value)];
}

function cliResult(
  executable: string,
  args: readonly string[],
  exitCode: number,
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[],
): PragmaCliResult {
  return {
    executable,
    args,
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}
