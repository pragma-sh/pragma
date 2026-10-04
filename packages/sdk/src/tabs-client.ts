// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type { Tab } from "@pragma-sh/constants";

import { routes } from "./routes";
import type { Transport } from "./transport";

/** Host-owned tab state a desktop reconciles its own rows against. */
export interface ManagedTabs {
  tabs: Tab[];
  /**
   * Ids of tabs closed through the host. A local row carrying one of these is
   * stale and must be deleted, never republished.
   */
  closedTabIds: string[];
}

/** Options for {@link TabsClient.openTerminal}. */
export interface OpenTerminalOptions {
  worktreeId: string;
  /**
   * Caller-generated id that makes the open idempotent. Reuse it when retrying:
   * a double tap or a retry after a lost response must not leave a second shell
   * running that nobody asked for.
   */
  requestId: string;
  /** Initial tab title. Omit to let the shell's own title stand. */
  title?: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for host-owned terminal tabs.
 *
 * A tab opened here belongs to the host, not to the client that asked for it:
 * it survives the desktop republishing its own rows, it survives a server
 * restart, and closing it ends the process on every device showing it.
 */
export class TabsClient {
  constructor(private readonly transport: Transport) {}

  /** Opens a terminal tab and its PTY in a worktree, using the host's shell. */
  openTerminal(options: OpenTerminalOptions): Promise<Tab> {
    return this.tabsRpc<Tab>(
      {
        action: "openTerminal",
        worktreeId: options.worktreeId,
        requestId: options.requestId,
        ...(options.title ? { title: options.title } : {}),
      },
      options.signal,
    );
  }

  /**
   * Closes a tab and ends its process everywhere. Idempotent, so a retry after
   * a lost response is safe — but the effect is not local, and a session
   * running an agent or a project script is ended for whoever else is watching
   * it, so a client should confirm before calling this.
   */
  async close(tabId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.tabsRpc({ action: "close", tabId }, options.signal);
  }

  /** Lists host-owned tabs in these worktrees, and the ids of closed ones. */
  listManaged(worktreeIds: string[], options: { signal?: AbortSignal } = {}): Promise<ManagedTabs> {
    return this.tabsRpc<ManagedTabs>({ action: "listManaged", worktreeIds }, options.signal);
  }

  private tabsRpc<T>(body: unknown, signal?: AbortSignal): Promise<T> {
    return this.transport.request<T>(routes.rpc("tabs"), { method: "POST", body, signal });
  }
}
