import { routes } from "./routes";
import type { Transport } from "./transport";
import type { CommandResult, ExecRunRequest } from "./types/exec";

/** Headless command execution RPC namespace. */
export class ExecClient {
  constructor(private readonly transport: Transport) {}

  run(payload: ExecRunRequest): Promise<CommandResult[]> {
    return this.transport.request<CommandResult[]>(routes.rpc("exec"), {
      body: { ...payload, env: payload.env ?? [], maxConcurrent: payload.maxConcurrent ?? 1 },
    });
  }
}
