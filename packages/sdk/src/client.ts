// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { AgentsClient } from "./agents-client";
import { AssetsClient } from "./assets-client";
import { EventsClient } from "./events-client";
import { ExecClient } from "./exec-client";
import { FanoutsClient } from "./fanouts-client";
import { FsClient } from "./fs-client";
import { GitClient } from "./git-client";
import { HealthClient } from "./health-client";
import { PushClient } from "./push-client";
import { routes } from "./routes";
import { ScratchpadsClient } from "./scratchpads-client";
import { SessionsClient } from "./sessions-client";
import { ThemeClient } from "./theme-client";
import { Transport } from "./transport";
import type { PragmaClientConfig } from "./transport";
import { WorkspaceClient } from "./workspace-client";

/** Fetch-based client for the local Pragma HTTP gateway. */
export class PragmaClient {
  readonly fs: FsClient;
  readonly git: GitClient;
  readonly exec: ExecClient;
  readonly sessions: SessionsClient;
  readonly agents: AgentsClient;
  readonly assets: AssetsClient;
  readonly events: EventsClient;
  readonly workspace: WorkspaceClient;
  readonly fanouts: FanoutsClient;
  readonly push: PushClient;
  readonly theme: ThemeClient;
  readonly health: HealthClient;
  readonly scratchpads: ScratchpadsClient;

  private readonly transport: Transport;

  constructor(config: PragmaClientConfig = {}) {
    this.transport = new Transport(config);
    this.fs = new FsClient(this.transport);
    this.git = new GitClient(this.transport);
    this.exec = new ExecClient(this.transport);
    this.sessions = new SessionsClient(this.transport);
    this.agents = new AgentsClient(this.transport);
    this.assets = new AssetsClient(this.transport);
    this.events = new EventsClient(this.transport);
    this.workspace = new WorkspaceClient(this.events);
    this.fanouts = new FanoutsClient(this.transport, this.events);
    this.push = new PushClient(this.transport);
    this.theme = new ThemeClient(this.transport);
    this.health = new HealthClient(this.transport);
    this.scratchpads = new ScratchpadsClient(this.transport, this.fs, this.agents);
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
