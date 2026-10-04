import type {
  AccountBindingScope,
  AccountLogin,
  AccountLoginSession,
  AccountUsageEntry,
  AccountsListResult,
} from "@pragma-sh/constants";

import { routes } from "./routes";
import type { Transport } from "./transport";

/**
 * One `accounts` RPC request. The desktop, the CLI, and this client all send
 * the same shape to the host that owns the project's accounts.
 */
export type AccountsRequest =
  | { action: "list"; projectRoot?: string | null }
  | { action: "refresh"; projectRoot?: string | null }
  | { action: "usage"; projectRoot?: string | null; accountKeys?: string[] | null }
  | {
      action: "beginLogin";
      pluginId: string;
      providerId: string;
      agentId: string;
      projectRoot?: string | null;
    }
  | { action: "loginStatus"; loginId: string }
  | { action: "loginInput"; loginId: string; data: string }
  | { action: "completeLogin"; loginId: string; projectRoot?: string | null }
  | { action: "cancelLogin"; loginId: string }
  | {
      action: "setBinding";
      agentId: string;
      provider: string;
      accountKey: string | null;
      scope: AccountBindingScope;
      projectRoot?: string | null;
    }
  | { action: "setLabel"; accountKey: string; label: string | null }
  | { action: "removeLogin"; loginId: string }
  | {
      action: "launchEnv";
      agentId: string;
      projectRoot?: string | null;
      tabId?: string | null;
    };

/** A sign-in that just started in the host's hidden login terminal. */
export interface AccountLoginStart {
  loginId: string;
  instructions: string | null;
}

/** Env for launching a harness with its bound accounts, as `[name, value]` pairs. */
export interface AccountLaunchEnv {
  env: Array<[string, string]>;
}

/** Sends one accounts request through some transport (gateway HTTP, Tauri IPC, …). */
export type AccountsSend = (request: AccountsRequest) => Promise<unknown>;

/**
 * Typed wrapper over the `accounts` RPC. Construct one over any {@link AccountsSend}
 * so every caller shares the same method surface.
 */
export class AccountsApi {
  constructor(private readonly send: AccountsSend) {}

  /** Providers, logins, bindings, and live session accounts (no plugin callbacks). */
  list(projectRoot?: string | null): Promise<AccountsListResult> {
    return this.send({ action: "list", projectRoot }) as Promise<AccountsListResult>;
  }

  /** Like {@link list}, after re-identifying every login. */
  refresh(projectRoot?: string | null): Promise<AccountsListResult> {
    return this.send({ action: "refresh", projectRoot }) as Promise<AccountsListResult>;
  }

  /** Usage limits, loaded once per account. */
  usage(projectRoot?: string | null, accountKeys?: string[]): Promise<AccountUsageEntry[]> {
    return this.send({ action: "usage", projectRoot, accountKeys }) as Promise<AccountUsageEntry[]>;
  }

  /** Starts a provider's login command in a hidden terminal on the host. */
  beginLogin(input: {
    pluginId: string;
    providerId: string;
    agentId: string;
    projectRoot?: string | null;
  }): Promise<AccountLoginStart> {
    return this.send({ action: "beginLogin", ...input }) as Promise<AccountLoginStart>;
  }

  /** The login terminal's printed URLs, output tail, and whether it exited. */
  loginStatus(loginId: string): Promise<AccountLoginSession> {
    return this.send({ action: "loginStatus", loginId }) as Promise<AccountLoginSession>;
  }

  /** Types into the login terminal (e.g. a pasted code followed by `\r`). */
  async loginInput(loginId: string, data: string): Promise<void> {
    await this.send({ action: "loginInput", loginId, data });
  }

  /** Identifies the new login and saves it. Rejects while it is not signed in yet. */
  completeLogin(loginId: string, projectRoot?: string | null): Promise<AccountLogin> {
    return this.send({ action: "completeLogin", loginId, projectRoot }) as Promise<AccountLogin>;
  }

  /** Stops a sign-in and discards its credential directory. */
  async cancelLogin(loginId: string): Promise<void> {
    await this.send({ action: "cancelLogin", loginId });
  }

  /**
   * Binds a harness to an account. `global` leaves every project override in
   * place; `project` needs `projectRoot`. `accountKey: null` clears the binding.
   */
  async setBinding(input: {
    agentId: string;
    provider: string;
    accountKey: string | null;
    scope: AccountBindingScope;
    projectRoot?: string | null;
  }): Promise<void> {
    await this.send({ action: "setBinding", ...input });
  }

  /** Sets (or with `null`, clears) an account's display label. */
  async setLabel(accountKey: string, label: string | null): Promise<void> {
    await this.send({ action: "setLabel", accountKey, label });
  }

  /** Deletes a Pragma-created login and its credential directory. */
  async removeLogin(loginId: string): Promise<void> {
    await this.send({ action: "removeLogin", loginId });
  }

  /** Env a launch of `agentId` needs; with `tabId` the accounts are recorded for it. */
  launchEnv(input: {
    agentId: string;
    projectRoot?: string | null;
    tabId?: string | null;
  }): Promise<AccountLaunchEnv> {
    return this.send({ action: "launchEnv", ...input }) as Promise<AccountLaunchEnv>;
  }
}

/** `client.accounts`: the account-provider API over the gateway. */
export class AccountsClient extends AccountsApi {
  constructor(transport: Transport) {
    super((request) =>
      transport.request(routes.rpc("accounts"), { method: "POST", body: request }),
    );
  }
}
