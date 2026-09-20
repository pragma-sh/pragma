import type {
  Whiteboard,
  WhiteboardCreateInput,
  WhiteboardEditInput,
  WhiteboardIdInput,
  WhiteboardListInput,
  WhiteboardViewResult,
} from "@pragma-sh/constants";

import { base64ToBytes } from "./encoding";
import { routes } from "./routes";
import type { Transport } from "./transport";

/** Whiteboard list input requiring the optional query field. */
export interface WhiteboardSearchInput extends WhiteboardListInput {
  query: string;
}

/** Input selecting one whiteboard for PNG rendering. */
export interface WhiteboardViewInput extends WhiteboardIdInput {
  /** Uses Excalidraw's dark export palette. */
  dark?: boolean;
}

/** Decoded PNG bytes returned by whiteboard rendering. */
export type WhiteboardViewBytes = Uint8Array;

/** Durable Excalidraw whiteboard RPC namespace. */
export class WhiteboardsClient {
  constructor(private readonly transport: Transport) {}

  /** Creates one worktree-scoped whiteboard. */
  create(input: WhiteboardCreateInput): Promise<Whiteboard> {
    return this.rpc("create", input);
  }

  /** Gets one whiteboard by durable id. */
  get(input: WhiteboardIdInput): Promise<Whiteboard> {
    return this.rpc("get", input);
  }

  /** Lists whiteboards for one worktree, optionally filtering by query. */
  list(input: WhiteboardListInput): Promise<Whiteboard[]> {
    return this.rpc("list", input);
  }

  /** Searches whiteboard titles and element text within one worktree. */
  search(input: WhiteboardSearchInput): Promise<Whiteboard[]> {
    return this.rpc("list", input);
  }

  /** Replaces one whiteboard after its optimistic version check. */
  edit(input: WhiteboardEditInput): Promise<Whiteboard> {
    return this.rpc("edit", input);
  }

  /** Deletes one whiteboard by durable id. */
  async delete(input: WhiteboardIdInput): Promise<void> {
    await this.rpc("delete", input);
  }

  /** Requests a rendered whiteboard and returns its decoded PNG bytes. */
  async view(input: WhiteboardViewInput): Promise<WhiteboardViewBytes> {
    const result = await this.rpc<WhiteboardViewResult>("view", input);
    return base64ToBytes(result.data);
  }

  private rpc<T>(action: string, input: object): Promise<T> {
    return this.transport.request<T>(routes.rpc("whiteboards"), {
      method: "POST",
      body: { action, ...input },
    });
  }
}
