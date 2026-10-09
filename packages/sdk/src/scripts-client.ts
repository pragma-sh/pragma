import { routes } from "./routes";
import type { Transport } from "./transport";

/** A live script run: its terminals, in the order the script names them. */
export interface ScriptRun {
  runId: string;
  worktreeId: string;
  name: string;
  tabIds: string[];
}

/** One named script as a client renders it: what it is, and whether it is going. */
export interface ScriptListing {
  name: string;
  icon: string | null;
  /**
   * How many terminals the script opens. More than one is several rows on a
   * phone rather than a split, which is a desktop layout.
   */
  commandCount: number;
  /** The live run, when this script is already going in this worktree. */
  run: ScriptRun | null;
}

/** Response of {@link ScriptsClient.list}. */
export interface ScriptList {
  scripts: ScriptListing[];
  /**
   * Why the config could not be read, when it exists but is malformed. An empty
   * list plus an error is a different state from a project with no scripts, and
   * a client must not render them the same way.
   */
  error: string | null;
}

/** Options for {@link ScriptsClient.run}. */
export interface RunScriptOptions {
  worktreeId: string;
  name: string;
  /** Caller-generated id that makes a retried start idempotent. */
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for a project's named run scripts.
 *
 * The host owns the run: it reads `.pragma/scripts.json` from the project root
 * (never from a child worktree, whose checkout may predate the script), opens
 * the terminals, and remembers which run they belong to. So "this is already
 * running" is one answer every device agrees on, and starting a dev server does
 * not need a desktop window open.
 */
export class ScriptsClient {
  constructor(private readonly transport: Transport) {}

  /** Lists the project's scripts, and which are running in this worktree. */
  list(worktreeId: string, options: { signal?: AbortSignal } = {}): Promise<ScriptList> {
    return this.scriptsRpc<ScriptList>({ action: "list", worktreeId }, options.signal);
  }

  /**
   * Starts a script, or returns the run already going.
   *
   * One run per script per worktree: a second tap while a dev server is up
   * shows it rather than starting a second one fighting for the same port.
   */
  run(options: RunScriptOptions): Promise<ScriptRun> {
    return this.scriptsRpc<ScriptRun>(
      {
        action: "run",
        worktreeId: options.worktreeId,
        name: options.name,
        requestId: options.requestId,
      },
      options.signal,
    );
  }

  /** Ends a run and closes the terminals it opened, on every device. */
  async stop(runId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.scriptsRpc({ action: "stop", runId }, options.signal);
  }

  private scriptsRpc<T>(body: unknown, signal?: AbortSignal): Promise<T> {
    return this.transport.request<T>(routes.rpc("scripts"), { method: "POST", body, signal });
  }
}
