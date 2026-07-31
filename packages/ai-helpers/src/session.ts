import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AuthStorage,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ModelKind } from "./constants.ts";
import type { ModelInsights } from "./model-insights.ts";
import { pickModel } from "./pick-model.ts";

/** Options for {@link createPragmaSession}. */
export interface CreatePragmaSessionOptions {
  /** Which model tier to select via {@link pickModel}. */
  modelKind: ModelKind;
  /** Working directory — drives AGENTS.md discovery and skill loading. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
  /**
   * Selective tool allowlist. When omitted, pi's defaults apply. Pass `[]` (or
   * `noTools: "all"`) for a pure text task. Skills and AGENTS.md are loaded by
   * the default resource loader regardless of which tools are enabled.
   */
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
  customTools?: ToolDefinition[];
  /** Explicit model to run. Defaults to {@link pickModel}. */
  model?: Model<Api>;
  /** modelgrep data used when this call has to pick the model itself. */
  insights?: ModelInsights;
}

/** Result of {@link createPragmaSession}. */
export interface PragmaSession {
  session: AgentSession;
  model: Model<Api>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Event union emitted by an {@link AgentSession} subscription. */
type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

function assistantMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function finalAssistantText(messages: readonly unknown[]): string | undefined {
  for (const message of messages.toReversed()) {
    const text = assistantMessageText(message);
    if (text) return text;
  }
  return undefined;
}

function assistantErrorMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") {
    return undefined;
  }
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : "The model returned an error.";
}

function finalAssistantError(messages: readonly unknown[]): string | undefined {
  for (const message of messages.toReversed()) {
    const error = assistantErrorMessage(message);
    if (error) return error;
  }
  return undefined;
}

/**
 * Create a pi agent session backed by a model chosen with {@link pickModel}.
 *
 * The session uses the default resource loader, so the worktree's `AGENTS.md`
 * is read into context and skills are available to be loaded; tools are limited
 * to the caller's allowlist. Throws when no model of the requested tier is
 * available (no authenticated provider offers one).
 */
export async function createPragmaSession(
  options: CreatePragmaSessionOptions,
): Promise<PragmaSession> {
  const model =
    options.model ??
    pickModel(options.modelKind, {
      authStorage: options.authStorage,
      registry: options.registry,
      insights: options.insights,
    });
  if (!model) {
    throw new Error(
      `No ${options.modelKind} model is available. Sign in to a provider that offers one.`,
    );
  }

  const { session } = await createAgentSession({
    model,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.registry,
    sessionManager: SessionManager.inMemory(),
    tools: options.tools,
    excludeTools: options.excludeTools,
    noTools: options.noTools,
    customTools: options.customTools,
  });

  return { session, model };
}

/**
 * Mutable accumulator for one {@link runPromptToText} attempt. `agent_end`
 * resets it when the run will retry, so deltas from a failed attempt never
 * leak into the resolved text.
 */
interface PromptRunState {
  text: string;
  latestAssistantText: string;
  latestAssistantError: string;
}

function resetPromptRunState(state: PromptRunState): void {
  state.text = "";
  state.latestAssistantText = "";
  state.latestAssistantError = "";
}

function handleAssistantTextDelta(state: PromptRunState, delta: string): void {
  state.text += delta;
}

function handleAssistantTextEnd(state: PromptRunState, content: string): void {
  const trimmed = content.trim();
  if (trimmed) {
    state.latestAssistantText = trimmed;
  }
}

function handleSessionMessageUpdate(
  event: Extract<SessionEvent, { type: "message_update" }>,
  state: PromptRunState,
  finish: (fn: () => void) => void,
  reject: (error: Error) => void,
): void {
  state.latestAssistantText = assistantMessageText(event.message) ?? state.latestAssistantText;
  state.latestAssistantError = assistantErrorMessage(event.message) ?? state.latestAssistantError;
  const inner = event.assistantMessageEvent;
  if (inner.type === "text_delta") {
    handleAssistantTextDelta(state, inner.delta);
  } else if (inner.type === "text_end") {
    handleAssistantTextEnd(state, inner.content);
  } else if (inner.type === "error") {
    finish(() => reject(new Error(inner.error.errorMessage ?? "The model returned an error.")));
  }
}

function handleSessionMessageEnd(
  event: Extract<SessionEvent, { type: "message_end" }>,
  state: PromptRunState,
): void {
  state.latestAssistantText = assistantMessageText(event.message) ?? state.latestAssistantText;
  state.latestAssistantError = assistantErrorMessage(event.message) ?? state.latestAssistantError;
}

function handleSessionAgentEnd(
  event: Extract<SessionEvent, { type: "agent_end" }>,
  state: PromptRunState,
  finish: (fn: () => void) => void,
  resolve: (text: string) => void,
  reject: (error: Error) => void,
): void {
  if (event.willRetry) {
    resetPromptRunState(state);
    return;
  }
  const finalText =
    state.text.trim() || state.latestAssistantText || finalAssistantText(event.messages);
  const finalError = state.latestAssistantError || finalAssistantError(event.messages);
  finish(() => {
    if (finalText) resolve(finalText);
    else if (finalError) reject(new Error(finalError));
    else reject(new Error("The model returned no text."));
  });
}

/**
 * Send one prompt and resolve with the assistant's final text. Accumulates
 * streamed text deltas and resolves when the agent run ends. Rejects if the
 * model reports an error.
 */
export function runPromptToText(session: AgentSession, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state: PromptRunState = {
      text: "",
      latestAssistantText: "",
      latestAssistantError: "",
    };
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      fn();
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        handleSessionMessageUpdate(event, state, finish, reject);
      } else if (event.type === "message_end") {
        handleSessionMessageEnd(event, state);
      } else if (event.type === "agent_end") {
        handleSessionAgentEnd(event, state, finish, resolve, reject);
      }
    });

    session.prompt(prompt).catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
