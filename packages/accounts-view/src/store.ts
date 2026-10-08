import {
  constants,
  type AccountBindingScope,
  type AccountUsageEntry,
  type AccountsListResult,
  type UsageLimitsResult,
} from "@pragma-sh/constants";
import type { AccountsApi } from "@pragma-sh/sdk";

import { validateUsageLimitsResult } from "./usage";

/** How often due usage loads are checked; each account keeps its own cadence. */
const USAGE_TICK_MS = 5000;

/** What the Account providers menu and Settings page render from. */
export interface AccountsState {
  list: AccountsListResult | null;
  usage: ReadonlyMap<string, UsageLimitsResult>;
  loading: boolean;
  error: string | null;
}

interface UsageSchedule {
  dueAt: number;
  failures: number;
}

/**
 * One project's accounts, as its owning host reports them. Shared by every
 * subscriber so the toolbar and Settings never poll the same host twice.
 */
export class ProjectAccounts {
  readonly api: AccountsApi;
  private state: AccountsState = { list: null, usage: new Map(), loading: true, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly schedules = new Map<string, UsageSchedule>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private usageInFlight = false;
  private listGeneration = 0;

  constructor(api: AccountsApi) {
    this.api = api;
  }

  getSnapshot = (): AccountsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Reloads providers and bindings; with `identify`, re-asks every login who it is. */
  async reload(identify = false): Promise<void> {
    const generation = ++this.listGeneration;
    try {
      const list = identify ? await this.api.refresh() : await this.api.list();
      if (generation !== this.listGeneration) return;
      this.setState({ list, loading: false, error: null });
      this.scheduleNewAccounts(list);
      void this.loadDueUsage();
    } catch (cause) {
      if (generation !== this.listGeneration) return;
      this.setState({ loading: false, error: errorMessage(cause) });
    }
  }

  /** Points a harness at an account, then reloads the effective bindings. */
  async setBinding(input: {
    agentId: string;
    provider: string;
    accountKey: string | null;
    scope: AccountBindingScope;
  }): Promise<void> {
    await this.api.setBinding(input);
    await this.reload();
  }

  /** Points several harnesses at accounts in one go, reloading once at the end. */
  async setBindings(
    inputs: Array<{
      agentId: string;
      provider: string;
      accountKey: string | null;
      scope: AccountBindingScope;
    }>,
  ): Promise<void> {
    try {
      await Promise.all(inputs.map((input) => this.api.setBinding(input)));
    } finally {
      await this.reload();
    }
  }

  async setLabel(accountKey: string, label: string | null): Promise<void> {
    await this.api.setLabel(accountKey, label);
    await this.reload();
  }

  async removeLogin(loginId: string): Promise<void> {
    await this.api.removeLogin(loginId);
    await this.reload();
  }

  /** Forces the next usage load for every account (the menu just opened). */
  refreshUsageNow(): void {
    for (const schedule of this.schedules.values()) schedule.dueAt = 0;
    void this.loadDueUsage();
  }

  private start(): void {
    void this.reload(true);
    this.timer = setInterval(() => void this.loadDueUsage(), USAGE_TICK_MS);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private scheduleNewAccounts(list: AccountsListResult): void {
    const keys = new Set(Object.values(list.loginKeys));
    for (const key of keys) {
      if (!this.schedules.has(key)) this.schedules.set(key, { dueAt: 0, failures: 0 });
    }
    for (const key of this.schedules.keys()) {
      if (!keys.has(key)) this.schedules.delete(key);
    }
  }

  private async loadDueUsage(): Promise<void> {
    const list = this.state.list;
    const due = this.dueKeys();
    if (!list || this.usageInFlight || due.length === 0) return;
    this.usageInFlight = true;
    try {
      this.applyUsage(list, due, await this.api.usage(null, due));
    } catch (cause) {
      for (const key of due) this.reschedule(key, null, null, true);
      console.warn("account usage refresh failed", cause);
    } finally {
      this.usageInFlight = false;
    }
  }

  private dueKeys(): string[] {
    const now = Date.now();
    return [...this.schedules.entries()]
      .filter(([, schedule]) => schedule.dueAt <= now)
      .map(([key]) => key);
  }

  private applyUsage(list: AccountsListResult, due: string[], entries: AccountUsageEntry[]): void {
    const usage = new Map(this.state.usage);
    for (const entry of entries) {
      const { result, refreshMs } = validatedUsage(list, entry);
      usage.set(entry.accountKey, result);
      this.reschedule(entry.accountKey, result, refreshMs);
    }
    // Accounts the host had nothing for (no usage support) wait a full cycle.
    const answered = new Set(entries.map((entry) => entry.accountKey));
    for (const key of due) {
      if (!answered.has(key)) this.reschedule(key, null, null);
    }
    this.setState({ usage });
  }

  private reschedule(
    key: string,
    result: UsageLimitsResult | null,
    requestedMs: number | null,
    failed = false,
  ): void {
    const schedule = this.schedules.get(key);
    if (!schedule) return;
    const interval = Math.max(constants.accounts.minRefreshMs, requestedMs ?? 0);
    const failure = failed || (result?.status === "unavailable" && result.reason === "error");
    schedule.failures = failure ? schedule.failures + 1 : 0;
    schedule.dueAt =
      Date.now() +
      (schedule.failures === 0
        ? interval
        : Math.min(interval * 2 ** schedule.failures, constants.accounts.maxRetryMs));
  }

  private setState(patch: Partial<AccountsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** One usage entry, validated against its provider's declared primary limit. */
function validatedUsage(
  list: AccountsListResult,
  entry: AccountUsageEntry,
): { result: UsageLimitsResult; refreshMs: number | null } {
  const info = providerForLogin(list, entry.loginId);
  return {
    result: validateUsageLimitsResult(
      info?.title ?? "Provider",
      info?.primaryLimitId ?? null,
      entry.result,
    ),
    refreshMs: info?.refreshIntervalMs ?? null,
  };
}

function providerForLogin(list: AccountsListResult, loginId: string) {
  const login = list.state.logins.find((candidate) => candidate.id === loginId);
  return login
    ? list.providers.find(
        (info) => info.pluginId === login.pluginId && info.providerId === login.providerId,
      )
    : undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
