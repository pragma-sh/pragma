import type { BoardDraftCreatePayload, KanbanPromptCard } from "@pragma-sh/constants";

import { AccountsClient } from "./accounts-client";
import { AgentsClient } from "./agents-client";
import { AiClient } from "./ai-client";
import { AssetsClient } from "./assets-client";
import { EventsClient } from "./events-client";
import { ExecClient } from "./exec-client";
import { FanoutsClient } from "./fanouts-client";
import { FsClient } from "./fs-client";
import { GitClient } from "./git-client";
import { GitHubClient } from "./github-client";
import { HealthClient } from "./health-client";
import { PortsClient } from "./ports-client";
import { PushClient } from "./push-client";
import { routes } from "./routes";
import { ScratchpadsClient } from "./scratchpads-client";
import { ScriptsClient } from "./scripts-client";
import { SessionsClient } from "./sessions-client";
import { TabsClient } from "./tabs-client";
import { ThemeClient } from "./theme-client";
import { Transport } from "./transport";
import type { PragmaClientConfig } from "./transport";
import { WhiteboardsClient } from "./whiteboards-client";
import { WorkspaceClient } from "./workspace-client";

/** Fetch-based client for the local Pragma HTTP gateway. */
export class PragmaClient {
  /** Host-owned account providers: logins, bindings, usage, and launch env. */
  readonly accounts: AccountsClient;
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
  readonly ports: PortsClient;
  readonly scratchpads: ScratchpadsClient;
  readonly ai: AiClient;
  readonly github: GitHubClient;
  readonly scripts: ScriptsClient;
  readonly tabs: TabsClient;
  /** Durable Excalidraw whiteboards. */
  readonly whiteboards: WhiteboardsClient;

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
    this.ports = new PortsClient(this.transport);
    this.scratchpads = new ScratchpadsClient(this.transport, this.fs, this.agents);
    this.ai = new AiClient(this.transport);
    this.github = new GitHubClient(this.transport);
    this.scripts = new ScriptsClient(this.transport);
    this.tabs = new TabsClient(this.transport);
    this.accounts = new AccountsClient(this.transport);
    this.whiteboards = new WhiteboardsClient(this.transport);
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

  /** Creates a draft on the agent board for an existing worktree. */
  createBoardDraft(
    payload: BoardDraftCreatePayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<KanbanPromptCard> {
    return this.transport.request<KanbanPromptCard>(routes.control("boardDraftCreate"), {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }
}
