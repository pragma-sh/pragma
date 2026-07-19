// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type {
  AgentAnswer,
  AgentCatalog,
  AgentDecision,
  AgentInput,
  AgentInterrupt,
  AgentMessage,
  AgentReportPayload,
  AgentSessionLaunchPayload,
} from "@pragma/constants";

import { PRAGMA_ENV_KEYS, hasPragmaEnvironment, readEnv } from "./env";
import { routes } from "./routes";
import { ndjsonStream } from "./streaming";
import { Transport } from "./transport";
import type {
  AgentConnection,
  AgentSessionLaunchResult,
  AgentStreamEvent,
  ConnectOptions,
  ReportMessageOptions,
  ReportOptions,
  ReportSessionNameOptions,
} from "./types/agents";

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

  /** Publishes a command-approval verdict, fanned out to agent subscribers. */
  reportDecision(payload: AgentDecision, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentDecisions, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  /** Publishes a reply to a question request, fanned out to agent subscribers. */
  reportAnswer(payload: AgentAnswer, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentAnswers, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  /** Publishes a free-form interjection, fanned out to agent subscribers. */
  reportInput(payload: AgentInput, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentInputs, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  /** Publishes a transient interrupt, fanned out to agent subscribers. */
  reportInterrupt(payload: AgentInterrupt, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.agentInterrupts, {
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

  /**
   * Reports the human-readable name of the agent's active session without
   * changing status. Pragma renames the hosting tab (user renames win). Call
   * again on every rename or session switch.
   */
  reportSessionName(options: ReportSessionNameOptions): Promise<void> {
    return reportWithClient(this, options, null, null, options.name);
  }

  /** Returns the resolved agent catalog assembled by the plugins sidecar. */
  catalog(options: { signal?: AbortSignal } = {}): Promise<AgentCatalog> {
    return this.transport.request<AgentCatalog>(routes.agentCatalog, {
      method: "GET",
      signal: options.signal,
    });
  }

  /**
   * Launches a new agent session through the brokered `agentSessionLaunch`
   * control route. A connected desktop persists tab/worktree metadata; without
   * one, the persistent host can launch into an existing mirrored worktree.
   */
  launch(
    payload: AgentSessionLaunchPayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSessionLaunchResult> {
    return this.transport.request<AgentSessionLaunchResult>(routes.control("agentSessionLaunch"), {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
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

  /**
   * Opens a single duplex channel to one running agent: async-iterate it to
   * read every event routed to `agent` + `tabId`, and use its methods to talk
   * back on the same channel ({@link AgentConnection.send} to interject,
   * {@link AgentConnection.answer} to reply to a question,
   * {@link AgentConnection.decide} to approve/deny a command). Supersedes the
   * old read-only agent-event subscription. When `prompt` is set it is delivered
   * as the first interjection before the connection is returned.
   */
  async connect(options: ConnectOptions): Promise<AgentConnection> {
    const { agent, tabId, worktreeId } = options;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort);

    const readStream = this.readStream.bind(this);
    async function* iterate(): AsyncGenerator<AgentStreamEvent> {
      try {
        for await (const event of readStream({ signal: controller.signal })) {
          if (matchesAgentTab(event, agent, tabId)) {
            yield event;
          }
        }
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    }

    const connection: AgentConnection = {
      [Symbol.asyncIterator]: iterate,
      send: (text, sendOptions = {}) =>
        this.reportInput(
          {
            agent,
            worktreeId,
            tabId,
            text,
            ...(sendOptions.requestId ? { requestId: sendOptions.requestId } : {}),
          },
          { signal: controller.signal },
        ),
      answer: (requestId, reply) =>
        this.reportAnswer(
          {
            agent,
            worktreeId,
            tabId,
            requestId,
            dismissed: reply === null,
            ...(reply !== null ? { answer: reply } : {}),
          },
          { signal: controller.signal },
        ),
      decide: (requestId, approved) =>
        this.reportDecision(
          { agent, worktreeId, tabId, requestId, approved },
          { signal: controller.signal },
        ),
      interrupt: (requestId) =>
        this.reportInterrupt(
          {
            agent,
            worktreeId,
            tabId,
            ...(requestId ? { requestId } : {}),
          },
          { signal: controller.signal },
        ),
      close: () => controller.abort(),
    };

    if (options.prompt !== undefined) {
      await connection.send(options.prompt);
    }
    return connection;
  }

  /** Raw, unfiltered agent event stream. Internal read half of {@link connect}. */
  private async *readStream(
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentStreamEvent> {
    const response = await this.transport.raw(routes.agentEvents, { signal: options.signal });
    yield* ndjsonStream<AgentStreamEvent>(response, options.signal);
  }

  /**
   * Blocks on the agent event stream until an {@link AgentDecision} matching
   * `agent` + `requestId` arrives, resolving its `approved` verdict. Resolves
   * `null` on timeout, abort, or stream error so a caller can fall back to the
   * harness's own permission prompt.
   */
  async awaitDecision(params: {
    agent: string;
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean | null> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    params.signal?.addEventListener("abort", onAbort);
    const timer =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : undefined;
    try {
      for await (const event of this.readStream({ signal: controller.signal })) {
        if (
          event.type === "agentDecision" &&
          event.decision.requestId === params.requestId &&
          event.decision.agent === params.agent
        ) {
          return event.decision.approved;
        }
      }
      return null;
    } catch {
      // Aborted (timeout) or stream error: no verdict, let the caller fall back.
      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      params.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Blocks on the agent event stream until an {@link AgentAnswer} matching
   * `agent` + `requestId` arrives, resolving its reply text. Resolves `null` on
   * dismiss, timeout, abort, or stream error so a caller can fall back to the
   * harness's own question prompt.
   */
  // fallow-ignore-next-line complexity -- event-stream filtering across answer types and edge cases
  async awaitAnswer(params: {
    agent: string;
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    params.signal?.addEventListener("abort", onAbort);
    const timer =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : undefined;
    try {
      for await (const event of this.readStream({ signal: controller.signal })) {
        if (
          event.type === "agentAnswer" &&
          event.answer.requestId === params.requestId &&
          event.answer.agent === params.agent
        ) {
          return event.answer.dismissed ? null : (event.answer.answer ?? "");
        }
      }
      return null;
    } catch {
      // Aborted (timeout) or stream error: no reply, let the caller fall back.
      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      params.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** True when a stream event is routed to the given agent + tab. */
// fallow-ignore-next-line complexity -- switch over 5 event types with field access; union-member narrowing is inherently verbose
function matchesAgentTab(event: AgentStreamEvent, agent: string, tabId: string): boolean {
  switch (event.type) {
    case "agent":
      return event.agent === agent && event.tabId === tabId;
    case "agentMessage":
      return event.message.agent === agent && event.message.tabId === tabId;
    case "agentDecision":
      return event.decision.agent === agent && event.decision.tabId === tabId;
    case "agentAnswer":
      return event.answer.agent === agent && event.answer.tabId === tabId;
    case "agentInput":
      return event.input.agent === agent && event.input.tabId === tabId;
    case "agentInterrupt":
      return event.interrupt.agent === agent && event.interrupt.tabId === tabId;
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

/**
 * Reports the session's display name without changing agent status. Pragma
 * renames the hosting tab unless the user renamed it manually; report again on
 * every rename or session switch.
 */
export function reportSessionName(options: ReportSessionNameOptions): Promise<void> {
  return reportWithStatus(options, null, null, options.name);
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

/** Options for {@link awaitAgentDecision}. */
export interface AwaitDecisionOptions {
  agent: string;
  requestId: string;
  timeoutMs?: number;
  client?: import("./client").PragmaClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * Resolves the approve/deny verdict a Pragma approval toast publishes for
 * `requestId`, or `null` when there is no Pragma gateway env, on timeout, or on
 * error. Used by a harness plugin (e.g. opencode's `permission.ask`) to turn a
 * remote approval into an in-process permission decision.
 */
export async function awaitAgentDecision(options: AwaitDecisionOptions): Promise<boolean | null> {
  if (!options.client && !hasPragmaEnvironment(options.env)) {
    return null;
  }
  const agents =
    options.client?.agents ??
    new AgentsClient(
      new Transport({
        baseUrl: readEnv(PRAGMA_ENV_KEYS.gatewayUrl, options.env),
        token: readEnv(PRAGMA_ENV_KEYS.gatewayToken, options.env),
      }),
    );
  return agents.awaitDecision({
    agent: options.agent,
    requestId: options.requestId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** Options for {@link awaitAgentAnswer}. */
export interface AwaitAnswerOptions {
  agent: string;
  requestId: string;
  timeoutMs?: number;
  client?: import("./client").PragmaClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * Resolves the reply text a Pragma question toast publishes for `requestId`, or
 * `null` when there is no Pragma gateway env, on dismiss, on timeout, or on
 * error. Used by a harness plugin to turn a remote answer into an in-process
 * question response.
 */
export async function awaitAgentAnswer(options: AwaitAnswerOptions): Promise<string | null> {
  if (!options.client && !hasPragmaEnvironment(options.env)) {
    return null;
  }
  const agents =
    options.client?.agents ??
    new AgentsClient(
      new Transport({
        baseUrl: readEnv(PRAGMA_ENV_KEYS.gatewayUrl, options.env),
        token: readEnv(PRAGMA_ENV_KEYS.gatewayToken, options.env),
      }),
    );
  return agents.awaitAnswer({
    agent: options.agent,
    requestId: options.requestId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

async function reportWithStatus(
  options: ReportOptions,
  status: AgentReportPayload["status"],
  attentionKind: AgentReportPayload["attentionKind"],
  sessionName?: string,
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
  await reportWithClient(agents, options, status, attentionKind, sessionName);
}

async function reportWithClient(
  agents: AgentsClient,
  options: ReportOptions,
  status: AgentReportPayload["status"],
  attentionKind: AgentReportPayload["attentionKind"],
  sessionName?: string,
): Promise<void> {
  const worktreeId = options.worktreeId ?? readEnv(PRAGMA_ENV_KEYS.worktreeId, options.env);
  const tabId = readEnv(PRAGMA_ENV_KEYS.tabId, options.env);
  if (!worktreeId || !tabId) {
    return;
  }
  await agents.report(
    reportPayload(options, { worktreeId, tabId }, status, attentionKind, sessionName),
    { signal: options.signal },
  );
}

function reportPayload(
  options: ReportOptions,
  routing: { worktreeId: string; tabId: string },
  status: AgentReportPayload["status"],
  attentionKind: AgentReportPayload["attentionKind"],
  sessionName?: string,
): AgentReportPayload {
  return {
    agent: options.agent,
    worktreeId: routing.worktreeId,
    tabId: routing.tabId,
    status,
    attentionKind,
    ...(sessionName ? { sessionName } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.question ? { question: options.question } : {}),
    ...(options.options && options.options.length > 0 ? { options: options.options } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
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
