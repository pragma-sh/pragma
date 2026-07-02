import { AgentsClient } from "./agents-client";
import { EventsClient } from "./events-client";
import { ExecClient } from "./exec-client";
import { FsClient } from "./fs-client";
import { GitClient } from "./git-client";
import { routes } from "./routes";
import { SessionsClient } from "./sessions-client";
import { Transport } from "./transport";
import type { PragmaClientConfig } from "./transport";

/** Fetch-based client for the local Pragma HTTP gateway. */
export class PragmaClient {
  readonly fs: FsClient;
  readonly git: GitClient;
  readonly exec: ExecClient;
  readonly sessions: SessionsClient;
  readonly agents: AgentsClient;
  readonly events: EventsClient;

  private readonly transport: Transport;

  constructor(config: PragmaClientConfig = {}) {
    this.transport = new Transport(config);
    this.fs = new FsClient(this.transport);
    this.git = new GitClient(this.transport);
    this.exec = new ExecClient(this.transport);
    this.sessions = new SessionsClient(this.transport);
    this.agents = new AgentsClient(this.transport);
    this.events = new EventsClient(this.transport);
  }

  rpc<T = unknown>(
    method: string,
    payload: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.transport.request<T>(routes.rpc(method), {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }
}
