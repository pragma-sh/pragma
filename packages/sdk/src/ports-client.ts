import type { OpenPort, PortForwardRequest, PortForwardResult } from "@pragma-sh/constants";

import { routes } from "./routes";
import type { Transport } from "./transport";

/** Options shared by port inventory reads. */
export interface ListOpenPortsOptions {
  signal?: AbortSignal;
}

/** Options for exposing one verified terminal-owned listener. */
export interface ForwardPortOptions {
  projectId: string;
  port: OpenPort;
  signal?: AbortSignal;
}

/** Host-owned open-port inventory and forwarding. */
export class PortsClient {
  constructor(private readonly transport: Transport) {}

  /** Lists TCP listeners descended from terminals in requested worktrees. */
  list(worktreeIds: string[], options: ListOpenPortsOptions = {}): Promise<OpenPort[]> {
    return this.transport.request<OpenPort[]>(routes.rpc("ports"), {
      method: "POST",
      body: { worktreeIds },
      signal: options.signal,
    });
  }

  /** Exposes one current listener through configured tunnel and design proxy. */
  forward(options: ForwardPortOptions): Promise<PortForwardResult> {
    const payload: PortForwardRequest = {
      projectId: options.projectId,
      worktreeId: options.port.worktreeId,
      tabId: options.port.tabId,
      pid: options.port.pid,
      port: options.port.port,
    };
    return this.transport.request<PortForwardResult>(routes.portForward, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }
}
