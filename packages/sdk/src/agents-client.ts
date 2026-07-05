// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type { AgentMessage, AgentReportPayload } from "@pragma/constants";

import { PRAGMA_ENV_KEYS, hasPragmaEnvironment, readEnv } from "./env";
import { routes } from "./routes";
import { ndjsonStream } from "./streaming";
import { Transport } from "./transport";
import type { AgentStreamEvent, ReportMessageOptions, ReportOptions } from "./types/agents";

/** Agent status gateway namespace. */
export class AgentsClient {
  constructor(private readonly transport: Transport) {}

  report(payload: AgentReportPayload, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentReports, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  reportMessage(payload: AgentMessage, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentMessages, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  reportStarted(options: ReportOptions): Promise<void> {
    return reportWithClient(this, options, "running", null);
  }

  reportStopped(options: ReportOptions): Promise<void> {
    return reportWithClient(this, options, "done", null);
  }

  reportAttention(options: ReportOptions): Promise<void> {
    return reportWithClient(this, options, "attention", options.kind ?? "question");
  }

  reportCleared(options: ReportOptions): Promise<void> {
    return reportWithClient(this, options, "cleared", null);
  }

  markAgentsSeen(
    payload: { tabId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.transport.request<void>(routes.agentsSeen(payload.tabId), {
      method: "POST",
      body: {},
      signal: options.signal,
    });
  }

  async *subscribe(options: { signal?: AbortSignal } = {}): AsyncGenerator<AgentStreamEvent> {
    const response = await this.transport.raw(routes.agentEvents, { signal: options.signal });
    yield* ndjsonStream<AgentStreamEvent>(response, options.signal);
  }
}

/** Reports an agent started status. */
export function reportStarted(options: ReportOptions): Promise<void> {
  return reportWithStatus(options, "running", null);
}

/** Reports an agent stopped/done status. */
export function reportStopped(options: ReportOptions): Promise<void> {
  return reportWithStatus(options, "done", null);
}

/** Reports an agent attention status. */
export function reportAttention(options: ReportOptions): Promise<void> {
  return reportWithStatus(options, "attention", options.kind ?? "question");
}

/** Reports an agent cleared status. */
export function reportCleared(options: ReportOptions): Promise<void> {
  return reportWithStatus(options, "cleared", null);
}

/** Reports one rich agent message. No-ops unless Pragma gateway env is present. */
export async function reportMessage(options: ReportMessageOptions): Promise<void> {
  if (!options.client && !hasPragmaEnvironment(options.env)) {
    return;
  }
  const agents =
    options.client?.agents ??
    new AgentsClient(
      new Transport({
        baseUrl: readEnv(PRAGMA_ENV_KEYS.gatewayUrl, options.env),
        token: readEnv(PRAGMA_ENV_KEYS.gatewayToken, options.env),
      }),
    );
  await reportMessageWithClient(agents, options);
}

async function reportWithStatus(
  options: ReportOptions,
  status: AgentReportPayload["status"],
  attentionKind: AgentReportPayload["attentionKind"],
): Promise<void> {
  if (!options.client && !hasPragmaEnvironment(options.env)) {
    return;
  }
  const agents =
    options.client?.agents ??
    new AgentsClient(
      new Transport({
        baseUrl: readEnv(PRAGMA_ENV_KEYS.gatewayUrl, options.env),
        token: readEnv(PRAGMA_ENV_KEYS.gatewayToken, options.env),
      }),
    );
  await reportWithClient(agents, options, status, attentionKind);
}

async function reportWithClient(
  agents: AgentsClient,
  options: ReportOptions,
  status: AgentReportPayload["status"],
  attentionKind: AgentReportPayload["attentionKind"],
): Promise<void> {
  const worktreeId = options.worktreeId ?? readEnv(PRAGMA_ENV_KEYS.worktreeId, options.env);
  const tabId = readEnv(PRAGMA_ENV_KEYS.tabId, options.env);
  if (!worktreeId || !tabId) {
    return;
  }
  await agents.report(
    {
      agent: options.agent,
      worktreeId,
      tabId,
      status,
      attentionKind,
    },
    { signal: options.signal },
  );
}

async function reportMessageWithClient(
  agents: AgentsClient,
  options: ReportMessageOptions,
): Promise<void> {
  const worktreeId =
    options.message.worktreeId ??
    options.worktreeId ??
    readEnv(PRAGMA_ENV_KEYS.worktreeId, options.env);
  const tabId = options.message.tabId ?? readEnv(PRAGMA_ENV_KEYS.tabId, options.env);
  if (!worktreeId || !tabId) {
    return;
  }
  await agents.reportMessage(
    {
      ...options.message,
      agent: options.message.agent ?? options.agent,
      worktreeId,
      tabId,
    },
    { signal: options.signal },
  );
}
