import type { Hooks } from "@opencode-ai/plugin";
import {
  type AgentAttentionKind,
  type AgentMessage,
  type AgentQuestion,
  type QuestionOption,
} from "@pragma/sdk";

type ReportKey = "started" | "stopped" | "cleared" | `attention:${AgentAttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

/** What a runtime event asks the reporter to do: re-derive status, reset, or nothing. */
type EventAction = "sync" | "clear" | "none";

function messageTextKey(messageID: string, partID?: string): string {
  return partID ? `${messageID}:${partID}` : messageID;
}

/** Chat-content-bearing runtime event types. */
const CHAT_EVENT_TYPES = new Set(["message.updated", "message.part.updated", "message.part.delta"]);

/** Parsed `session.created`/`session.updated` info payload. */
interface SessionEventInfo {
  id: string;
  parentId: string | null;
  title: string | null;
}

/** Extracts session id/parent/title from a session lifecycle event, if any. */
function sessionEventInfo(event: RuntimeEvent): SessionEventInfo | null {
  if (event.type !== "session.created" && event.type !== "session.updated") {
    return null;
  }
  const properties = event.properties;
  const info = isRecord(properties) && isRecord(properties.info) ? properties.info : null;
  if (!info || typeof info.id !== "string") {
    return null;
  }
  return {
    id: info.id,
    parentId: typeof info.parentID === "string" && info.parentID ? info.parentID : null,
    title: sessionInfoTitle(info),
  };
}

function sessionInfoTitle(info: Record<string, unknown>): string | null {
  const title = typeof info.title === "string" ? info.title.trim() : "";
  return title || null;
}

const PRAGMA_ENV_KEYS = [
  "PRAGMA_GATEWAY_URL",
  "PRAGMA_GATEWAY_TOKEN",
  "PRAGMA_DAEMON_SOCKET",
  "PRAGMA_TAB_ID",
  "PRAGMA_WORKTREE_ID",
] as const;

export interface PragmaReporter {
  readonly env: Environment;
  started(): Promise<void>;
  stopped(): Promise<void>;
  attention(kind: AgentAttentionKind): Promise<void>;
  message(message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">): Promise<void>;
  /** Removes the tab's indicator entirely (agent process exited), not a green "done". */
  cleared(): Promise<void>;
  /** Reports the session's display name so Pragma can rename the hosting tab. */
  sessionName(name: string): Promise<void>;
  /**
   * Reports a `command` attention carrying the command text + a correlation id.
   * Drives the Pragma approval toast; the paired host-side watcher answers the
   * verdict with `sendKeys`. Used for opencode's permission prompts (which have
   * no returnable-decision plugin hook on the current binary).
   */
  attentionCommand(command: string, requestId: string): Promise<void>;
  /**
   * Reports a `question` attention carrying the prompt, answer choices, and a
   * correlation id so a non-terminal client can render radio options and reply.
   */
  attentionQuestion(question: string, options: QuestionOption[], requestId: string): Promise<void>;
  /**
   * Reports a `question` attention carrying several questions. The mobile
   * answer UI renders them as a back/next wizard and submits one line with all
   * answers.
   */
  attentionQuestions(questions: AgentQuestion[], requestId: string): Promise<void>;
}

/**
 * Creates opencode hooks that mirror runtime activity into Pragma agent reports.
 *
 * Status is derived from two orthogonal flags rather than mapped per event, so
 * precedence is explicit and stable: **attention (red) > busy (yellow) > idle
 * (green)**. opencode streams a flurry of `message.*` events while generating
 * and emits a separate idle signal when a turn ends; deriving the reported
 * status from the flags (and only emitting on change) keeps a trailing stream
 * event from clobbering green back to yellow, and keeps red pinned while a
 * prompt is awaiting an answer even though the session reports idle meanwhile.
 */
export function createPragmaOpencodeHooks(reporter: PragmaReporter): Hooks {
  let busy = false;
  let attention = false;
  let attentionKind: AgentAttentionKind = "command";
  let lastReported: ReportKey | null = null;
  let reportQueue = Promise.resolve();
  /** messageID → role, filled from `message.updated` so text parts can be attributed. */
  const messageRoles = new Map<string, "user" | "assistant">();
  /** partID → OpenCode part type, used to distinguish reasoning deltas from final text. */
  const partTypes = new Map<string, string>();
  /** messageID/partID → accumulated text from `message.part.delta` events. */
  const messageText = new Map<string, string>();
  /** Child session id → parent session id. Child lifecycle keeps its parent busy. */
  const childSessions = new Map<string, string>();
  const activeChildSessions = new Set<string>();
  let pendingLegacyQuestion: ReturnType<typeof setTimeout> | null = null;
  let activeCanonicalQuestionId: string | null = null;

  const EVENT_HANDLERS: Record<string, (event: RuntimeEvent) => EventAction> = {
    "session.status": applySessionStatusEvent,
    "session.idle": applySessionIdleEvent,
    "session.error": applySessionErrorEvent,
    "session.deleted": applySessionDeletedEvent,
    "server.instance.disposed": () => "clear",
    "permission.replied": applyPermissionRepliedEvent,
    "question.replied": applyQuestionRepliedEvent,
    "question.rejected": applyQuestionRepliedEvent,
    "message.updated": applyMessageUpdatedEvent,
    "message.part.updated": applyMessagePartEvent,
  };
  const chatContentHandlers: Record<string, (event: RuntimeEvent) => Promise<void>> = {
    "message.updated": async (event) => {
      rememberMessageRole(event);
    },
    "message.part.delta": reportChatDelta,
    "message.part.updated": reportUpdatedPart,
  };

  let lastSessionName: string | null = null;

  /** Mirrors a child session's lifecycle onto its parent. Returns true if handled. */
  async function handleChildSessionEvent(event: RuntimeEvent): Promise<boolean> {
    if (!isChildSessionEvent(event)) {
      return false;
    }
    const parentId = childSessions.get(sessionIdFromEvent(event) ?? "");
    if (applyChildSessionEvent(event)) {
      await reportSubagentActivity(parentId);
      await sync();
    }
    return true;
  }

  /**
   * A permission request: report the command + a requestId so a Pragma approval
   * toast appears, and pin the red dot. opencode exposes no decision-returning
   * plugin hook on the current binary, so the paired watcher answers the verdict
   * with `sendKeys` (see pragma-plugin.ts). Returns true if handled.
   */
  async function handlePermissionEvent(event: RuntimeEvent): Promise<boolean> {
    if (event.type !== "permission.asked" && event.type !== "permission.updated") {
      return false;
    }
    await raiseCommandApproval(event);
    return true;
  }

  /** Raises a question attention for `question.asked`. Returns true if handled. */
  async function handleQuestionAskedEvent(event: RuntimeEvent): Promise<boolean> {
    if (event.type !== "question.asked") {
      return false;
    }
    cancelPendingLegacyQuestion();
    activeCanonicalQuestionId = questionRequestId(event) ?? null;
    await raiseQuestionAttention(
      isRecord(event.properties) ? event.properties : {},
      questionRequestId(event),
    );
    return true;
  }

  /** Runs the handlers that fully consume an event, short-circuiting the status sync. */
  async function handleConsumingEvent(event: RuntimeEvent): Promise<boolean> {
    return (
      (await handleChildSessionEvent(event)) ||
      (await handlePermissionEvent(event)) ||
      (await handleQuestionAskedEvent(event))
    );
  }

  /**
   * Assistant (and other) chat content rides on message.* events; report it
   * before the status sync so a trailing idle still carries the reply.
   */
  async function reportChatAndApplyStatus(event: RuntimeEvent): Promise<void> {
    if (CHAT_EVENT_TYPES.has(event.type)) {
      await reportChatContent(event);
    }
    const action = applyEvent(event);
    if (action === "clear") {
      await clear();
    } else if (action === "sync") {
      await sync();
    }
  }

  return {
    event: async ({ event }) => {
      const runtimeEvent = event as RuntimeEvent;
      rememberSessionKind(runtimeEvent);
      await maybeReportSessionName(runtimeEvent);
      if (await handleConsumingEvent(runtimeEvent)) {
        return;
      }
      await reportChatAndApplyStatus(runtimeEvent);
    },
    "chat.message": async (_input, output) => {
      if (isChildSessionId(_input.sessionID)) {
        return;
      }
      busy = true;
      const text =
        textFromParts(output.parts) ??
        textFromRecord(output.message as unknown as Record<string, unknown>);
      await queueReport(() =>
        reporter.message({
          id: messageId("chat"),
          role: "user",
          ...(text ? { text } : {}),
          subAgentsActive: 0,
          ts: Date.now(),
        }),
      );
      await sync();
    },
    "command.execute.before": async (input) => {
      if (isChildSessionId(input.sessionID)) {
        return;
      }
      busy = true;
      await queueReport(() =>
        reporter.message(
          toolMessage("command", summaryFromRecord(input as Record<string, unknown>)),
        ),
      );
      await sync();
    },
    "tool.execute.before": async (input, output) => {
      if (isChildSessionId(input.sessionID)) {
        return;
      }
      const args = isRecord(output?.args) ? output.args : {};
      if (input.tool === "question") {
        scheduleLegacyQuestionAttention(
          args,
          typeof input.callID === "string" ? `opencode-question-${input.callID}` : undefined,
        );
        // Surface a short human line in the transcript — never the raw args JSON.
        const parsed = parseQuestionArgs(args);
        await queueReport(() =>
          reporter.message(
            toolMessage("question", parsed?.[0]?.question ?? "Waiting for an answer"),
          ),
        );
        return;
      }
      busy = true;
      await queueReport(() =>
        reporter.message(toolMessage(input.tool, toolSummary(input.tool, args))),
      );
      await sync();
    },
    "permission.ask": async (input) => {
      if (isRecord(input) && isChildSessionId(input.sessionID)) {
        return;
      }
      // Kept for opencode builds that DO call this hook (absent from the verified
      // binary). Same command-approval report as the `permission.asked` event.
      await raiseCommandApproval(input);
    },
    "shell.env": async (_input, output) => {
      for (const key of PRAGMA_ENV_KEYS) {
        const value = reporter.env[key];
        if (value) {
          output.env[key] = value;
        }
      }
    },
    dispose: async () => {
      // The agent process is exiting, not just finishing a turn: clear the
      // indicator outright rather than leaving a green "done" dot behind.
      await clear();
    },
  };

  function rememberSessionKind(event: RuntimeEvent): void {
    const info = sessionEventInfo(event);
    if (!info?.parentId) {
      return;
    }
    childSessions.set(info.id, info.parentId);
    if (event.type === "session.created") {
      activeChildSessions.add(info.id);
      busy = true;
    }
  }

  /**
   * Mirrors the parent session's title into a Pragma session-name report so
   * the hosting tab tracks opencode's own session naming (including renames
   * and session switches). Child (subagent) sessions never rename the tab.
   */
  async function maybeReportSessionName(event: RuntimeEvent): Promise<void> {
    const info = sessionEventInfo(event);
    if (!info || childSessions.has(info.id)) {
      return;
    }
    if (!info.title || info.title === lastSessionName) {
      return;
    }
    lastSessionName = info.title;
    await reporter.sessionName(info.title);
  }

  function applyChildSessionEvent(event: RuntimeEvent): boolean {
    const sessionId = sessionIdFromEvent(event);
    if (!sessionId) {
      return false;
    }
    if (event.type === "session.created") {
      activeChildSessions.add(sessionId);
      busy = true;
      return true;
    }
    if (event.type === "session.status") {
      applyChildStatusEvent(sessionId, event);
      return true;
    }
    if (
      event.type === "session.idle" ||
      event.type === "session.error" ||
      event.type === "session.deleted"
    ) {
      activeChildSessions.delete(sessionId);
      if (event.type === "session.deleted") {
        childSessions.delete(sessionId);
      }
      return true;
    }
    return false;
  }

  function applyChildStatusEvent(sessionId: string, event: RuntimeEvent): void {
    const properties = isRecord(event.properties)
      ? (event.properties as Record<string, unknown>)
      : undefined;
    const status = properties?.status;
    if (isRecord(status) && status.type === "idle") {
      activeChildSessions.delete(sessionId);
    } else {
      activeChildSessions.add(sessionId);
      busy = true;
    }
  }

  function isChildSessionEvent(event: RuntimeEvent): boolean {
    return isChildSessionId(sessionIdFromEvent(event));
  }

  function isChildSessionId(sessionId: unknown): boolean {
    return typeof sessionId === "string" && childSessions.has(sessionId);
  }

  /**
   * Resets all status and removes the tab's indicator entirely (the agent quit
   * or its turn was aborted — there is no result to "go look" at). Distinct from
   * `stopped`/`done`, which leaves a green dot.
   */
  async function clear(): Promise<void> {
    cancelPendingLegacyQuestion();
    activeCanonicalQuestionId = null;
    busy = false;
    attention = false;
    childSessions.clear();
    activeChildSessions.clear();
    if (lastReported === "cleared") {
      return;
    }
    lastReported = "cleared";
    await queueReport(() => reporter.cleared());
  }

  function currentReport(): ReportKey {
    if (attention) {
      return `attention:${attentionKind}`;
    }
    if (busy) {
      return "started";
    }
    return "stopped";
  }

  async function sync(): Promise<void> {
    const next = currentReport();
    if (next === lastReported) {
      return;
    }
    // `stopped` is the green "finished, go look" signal — only meaningful once
    // the agent has actually been running. Suppressing it otherwise stops a bare
    // idle, or the idle that may trail an aborted/cleared turn, from resurrecting
    // a phantom "finished" dot and notification.
    if (next === "stopped" && lastReported !== "started") {
      return;
    }
    lastReported = next;
    if (next === "started") {
      await queueReport(() => reporter.started());
    } else if (next === "stopped") {
      await queueReport(() => reporter.stopped());
    } else {
      await queueReport(() => reporter.attention(attentionKind));
    }
  }

  function queueReport(send: () => Promise<void>): Promise<void> {
    const pending = reportQueue.then(send);
    reportQueue = pending.catch(() => undefined);
    return pending;
  }

  /** Updates the flags for a runtime event and returns the action to take. */
  function applyEvent(event: RuntimeEvent): EventAction {
    const handler = EVENT_HANDLERS[event.type];
    return handler ? handler(event) : "none";
  }

  function applySessionStatusEvent(event: RuntimeEvent): EventAction {
    applySessionStatus(event);
    return "sync";
  }

  function applySessionIdleEvent(event: RuntimeEvent): EventAction {
    const sessionId = sessionIdFromEvent(event);
    busy = hasActiveChildren(sessionId);
    return "sync";
  }

  function applySessionErrorEvent(event: RuntimeEvent): EventAction {
    // An aborted turn (esc-esc / `session.abort`) surfaces as a session
    // error carrying `MessageAbortedError`. There is no result to look at,
    // so reset the indicator instead of leaving a green "finished" dot.
    if (isAbortError(event)) {
      return "clear";
    }
    busy = false;
    attention = false;
    removeChildren(sessionIdFromEvent(event));
    return "sync";
  }

  function applySessionDeletedEvent(event: RuntimeEvent): EventAction {
    busy = false;
    attention = false;
    removeChildren(sessionIdFromEvent(event));
    return "sync";
  }

  function hasActiveChildren(parentId: string | undefined): boolean {
    for (const childId of activeChildSessions) {
      if (!parentId || childSessions.get(childId) === parentId) {
        return true;
      }
    }
    return false;
  }

  function removeChildren(parentId: string | undefined): void {
    if (!parentId) {
      return;
    }
    for (const [childId, childParentId] of childSessions) {
      if (childParentId === parentId) {
        childSessions.delete(childId);
        activeChildSessions.delete(childId);
      }
    }
  }

  /**
   * Reports a command-approval attention (command text + a fresh requestId) and
   * pins the flags so a later `sync` does not re-report a generic duplicate. The
   * source is a `permission.asked`/`updated` event or the `permission.ask` hook
   * input — both carry the permission payload.
   */
  async function raiseCommandApproval(source: RuntimeEvent | unknown): Promise<void> {
    attention = true;
    attentionKind = "command";
    lastReported = "attention:command";
    await queueReport(() =>
      reporter.attentionCommand(commandFromPermission(source), permissionRequestId()),
    );
  }

  /**
   * Reports a question attention with the parsed prompt + choices. Pins
   * `lastReported` so a later generic `sync` does not re-emit a bare
   * `attention:question` that would drop the question text/options.
   */
  async function raiseQuestionAttention(
    args: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<void> {
    const parsed = parseQuestionArgs(args);
    if (!parsed || parsed.length === 0) {
      return;
    }
    attention = true;
    attentionKind = "question";
    lastReported = "attention:question";
    const requestIdResolved = requestId ?? permissionRequestId();
    await queueReport(() => {
      if (parsed.length === 1 && parsed[0]) {
        return reporter.attentionQuestion(parsed[0].question, parsed[0].options, requestIdResolved);
      }
      return reporter.attentionQuestions(
        parsed.map((item) => ({ question: item.question, options: item.options })),
        requestIdResolved,
      );
    });
  }

  function applyPermissionRepliedEvent(): EventAction {
    attention = false;
    busy = true;
    return "sync";
  }

  function applyQuestionRepliedEvent(event: RuntimeEvent): EventAction {
    const responseId = questionResponseId(event);
    if (activeCanonicalQuestionId !== null && responseId !== activeCanonicalQuestionId) {
      return "none";
    }
    cancelPendingLegacyQuestion();
    activeCanonicalQuestionId = null;
    attention = false;
    busy = true;
    return "sync";
  }

  function applyMessageUpdatedEvent(event: RuntimeEvent): EventAction {
    rememberMessageRole(event);
    return "none";
  }

  function applyMessagePartEvent(event: RuntimeEvent): EventAction {
    return applyQuestionPart(event) ? "sync" : "none";
  }

  async function reportSubagentActivity(parentId: string | undefined): Promise<void> {
    if (!parentId) return;
    let active = 0;
    for (const childId of activeChildSessions) {
      if (childSessions.get(childId) === parentId) active += 1;
    }
    await queueReport(() =>
      reporter.message({
        id: `subagents:${parentId}`,
        role: "system",
        subAgentsActive: active,
        ts: Date.now(),
      }),
    );
  }

  /**
   * Surfaces chat content from message.* events into Pragma. Status flags stay
   * in the sync path; this only publishes {@link PragmaReporter.message}.
   */
  async function reportChatContent(event: RuntimeEvent): Promise<void> {
    const handler = chatContentHandlers[event.type];
    if (handler) await handler(event);
  }

  async function reportUpdatedPart(event: RuntimeEvent): Promise<void> {
    const part = partFromEvent(event);
    if (!part) {
      return;
    }
    rememberPartType(part);
    const details = assistantTextPart(part);
    // OpenCode can emit an assistant text part before its message.updated role
    // event. Only suppress a part once we positively know it belongs to a user;
    // chat.message already reports those prompts.
    if (!details || messageRoles.get(details.messageID) === "user") {
      return;
    }
    const key = messageTextKey(details.messageID, details.partID);
    messageText.set(key, details.text);
    await reportAssistantText(details.messageID, details.text, details.partType, details.partID);
  }

  function rememberPartType(part: Record<string, unknown>): void {
    const partID = typeof part.id === "string" ? part.id : undefined;
    const partType = typeof part.type === "string" ? part.type : undefined;
    if (partID && partType) partTypes.set(partID, partType);
  }

  /** Accumulates OpenCode's incremental text event and publishes a growing snapshot. */
  async function reportChatDelta(event: RuntimeEvent): Promise<void> {
    const delta = chatDelta(event, messageRoles);
    if (!delta) {
      return;
    }
    const key = messageTextKey(delta.messageID, delta.partID);
    const text = `${messageText.get(key) ?? ""}${delta.text}`;
    messageText.set(key, text);
    await reportAssistantText(
      delta.messageID,
      text,
      delta.partID ? partTypes.get(delta.partID) : undefined,
      delta.partID,
    );
  }

  /** Reports one assistant text snapshot under its stable transcript id. */
  async function reportAssistantText(
    messageID: string,
    text: string,
    partType?: string,
    partID?: string,
  ): Promise<void> {
    const isReasoning = partType === "reasoning";
    await queueReport(() =>
      reporter.message({
        id: isReasoning ? `reasoning:${messageID}:${partID ?? "part"}` : `assistant:${messageID}`,
        role: isReasoning ? "system" : "assistant",
        text,
        subAgentsActive: 0,
        ts: Date.now(),
      }),
    );
  }

  /** Records `message.updated` role so later text parts can be attributed. */
  function rememberMessageRole(event: RuntimeEvent): void {
    const properties = event.properties as Record<string, unknown> | undefined;
    const info = properties?.info;
    if (!isRecord(info) || typeof info.id !== "string") {
      return;
    }
    if (info.role === "user" || info.role === "assistant") {
      messageRoles.set(info.id, info.role);
    }
  }

  /** Whether a `session.error` event carries opencode's abort error. */
  function isAbortError(event: RuntimeEvent): boolean {
    const error = (event.properties as Record<string, unknown> | undefined)?.error;
    return isRecord(error) && error.name === "MessageAbortedError";
  }

  function applySessionStatus(event: RuntimeEvent): void {
    const status = (event.properties as Record<string, unknown> | undefined)?.status;
    busy = !(isRecord(status) && status.type === "idle");
  }

  /** Handles only the question tool: raise attention while pending, resume once resolved. */
  function applyQuestionPart(event: RuntimeEvent): boolean {
    const part = partFromEvent(event);
    if (!part || part.type !== "tool" || part.tool !== "question") {
      return false;
    }
    applyQuestionPartState(part);
    return true;
  }

  /** Pulls the `part` record out of a `message.part.updated` event, if any. */
  function partFromEvent(event: RuntimeEvent): Record<string, unknown> | undefined {
    const properties = event.properties;
    const part = isRecord(properties) && "part" in properties ? properties.part : undefined;
    return isRecord(part) ? part : undefined;
  }

  /** Updates flags from a question tool part's state: resume when resolved, else raise. */
  function applyQuestionPartState(part: Record<string, unknown>): void {
    if (activeCanonicalQuestionId !== null) {
      return;
    }
    const state = isRecord(part.state) ? part.state : undefined;
    if (questionPartFinished(state)) {
      cancelPendingLegacyQuestion();
      attention = false;
      busy = true;
      return;
    }
    // Use legacy structured input when present. OpenCode 1.18 emits the
    // canonical `question.asked` event after incomplete tool-state updates.
    const input = questionPartInput(state, part);
    if (input) {
      scheduleLegacyQuestionAttention(
        input,
        typeof part.callID === "string" ? `opencode-question-${part.callID}` : undefined,
      );
    }
  }

  function scheduleLegacyQuestionAttention(
    args: Record<string, unknown>,
    requestId: string | undefined,
  ): void {
    if (activeCanonicalQuestionId !== null) {
      return;
    }
    cancelPendingLegacyQuestion();
    // OpenCode 1.18 invokes legacy question hooks immediately before emitting
    // `question.asked`, whose `que_*` id is the only id its live prompt owns.
    // Defer fallback reporting until that canonical event has a chance to win.
    pendingLegacyQuestion = setTimeout(() => {
      pendingLegacyQuestion = null;
      if (activeCanonicalQuestionId !== null) {
        return;
      }
      void raiseQuestionAttention(args, requestId).catch(() => undefined);
    }, 50);
  }

  function cancelPendingLegacyQuestion(): void {
    if (pendingLegacyQuestion !== null) {
      clearTimeout(pendingLegacyQuestion);
      pendingLegacyQuestion = null;
    }
  }
}

export type { Environment };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sessionIdFromEvent(event: RuntimeEvent): string | undefined {
  if (!isRecord(event.properties)) {
    return undefined;
  }
  const properties = event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") {
    return properties.sessionID;
  }
  for (const key of ["info", "part", "permission"]) {
    const nested = properties[key];
    if (isRecord(nested) && typeof nested.sessionID === "string") {
      return nested.sessionID;
    }
    if (key === "info" && isRecord(nested) && typeof nested.id === "string") {
      return nested.id;
    }
  }
  return undefined;
}

function assistantTextPart(
  part: Record<string, unknown>,
): { messageID: string; partID: string | undefined; partType: string; text: string } | undefined {
  const partType = typeof part.type === "string" ? part.type : undefined;
  if (partType !== "text" && partType !== "reasoning") return undefined;
  const messageID = typeof part.messageID === "string" ? part.messageID : undefined;
  const text = typeof part.text === "string" ? part.text.trim() : "";
  if (!messageID || !text) return undefined;
  return {
    messageID,
    partID: typeof part.id === "string" ? part.id : undefined,
    partType,
    text,
  };
}

function chatDelta(
  event: RuntimeEvent,
  messageRoles: ReadonlyMap<string, "user" | "assistant">,
): { messageID: string; partID: string | undefined; text: string } | undefined {
  const properties = event.properties;
  if (!isRecord(properties) || !isTextDelta(properties)) {
    return undefined;
  }
  const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
  if (!messageID || messageRoles.get(messageID) === "user") {
    return undefined;
  }
  return {
    messageID,
    partID: typeof properties.partID === "string" ? properties.partID : undefined,
    text: properties.delta,
  };
}

function isTextDelta(
  properties: Record<string, unknown>,
): properties is Record<string, unknown> & { delta: string } {
  return (
    (properties.field === undefined || properties.field === "text") &&
    typeof properties.delta === "string" &&
    properties.delta.length > 0
  );
}

function questionPartFinished(state: Record<string, unknown> | undefined): boolean {
  return state?.status === "completed" || state?.status === "error";
}

function questionPartInput(
  state: Record<string, unknown> | undefined,
  part: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(state?.input) ? state.input : isRecord(part.input) ? part.input : undefined;
}

function questionRequestId(event: RuntimeEvent): string | undefined {
  const properties: unknown = event.properties;
  return isRecord(properties) && typeof properties.id === "string" ? properties.id : undefined;
}

function questionResponseId(event: RuntimeEvent): string | undefined {
  const properties: unknown = event.properties;
  if (!isRecord(properties)) return undefined;
  if (typeof properties.requestID === "string") return properties.requestID;
  return typeof properties.id === "string" ? properties.id : undefined;
}

/** A unique correlation id for one command-approval round-trip. Opaque. */
function permissionRequestId(): string {
  return `opencode-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

/**
 * Best-effort human description of what an opencode permission is asking to do —
 * the shell command for a `bash` permission, or the file being read/written/edited
 * for a file-tool permission — rather than a generic "Run a command" label.
 *
 * The source is a `permission.asked`/`updated` event or the `permission.ask` hook
 * input. Both carry the `Permission`, but the exact nesting varies across opencode
 * builds (`.properties`, `.properties.permission`, or the permission directly), so
 * {@link unwrapPermission} normalizes it first, then we probe the known fields
 * without depending on the precise shape. Falls back to a generic label so the
 * toast always shows something.
 */
function commandFromPermission(source: unknown): string {
  const permission = unwrapPermission(source);
  const metadata = isRecord(permission.metadata) ? permission.metadata : {};

  // A shell command (the `bash` tool) — show the command line verbatim.
  const command = firstNestedString(permission, ["command", "cmd", "script", "shell"]);
  if (command) {
    return command;
  }

  // A file tool (read/write/edit/patch) — show the verb + the path it touches.
  const filePath = firstNestedString(permission, ["filePath", "filepath", "path", "file"]);
  if (filePath) {
    const verb = fileToolVerb(firstString(permission.type, permission.pattern, metadata.tool));
    return verb ? `${verb} ${filePath}` : filePath;
  }

  // A network tool (webfetch) or anything else opencode labels for us.
  return (
    firstNestedString(permission, ["url", "uri"]) ??
    firstString(
      permission.title,
      metadata.title,
      permission.description,
      metadata.description,
      permission.pattern,
      permission.type,
    ) ??
    "Run a command"
  );
}

/**
 * Normalizes the varying opencode permission-event shapes to the permission
 * record: an event nests it under `.properties` (and some builds under
 * `.properties.permission`), while the `permission.ask` hook passes it directly.
 */
function unwrapPermission(source: unknown): Record<string, unknown> {
  const outer = isRecord(source) ? source : {};
  const inner = isRecord(outer.properties) ? outer.properties : outer;
  return isRecord(inner.permission) ? inner.permission : inner;
}

/** Maps an opencode file-tool type/pattern to a display verb, if it is one. */
function fileToolVerb(type: string | undefined): string | undefined {
  switch (type?.toLowerCase()) {
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
    case "patch":
      return "Edit";
    default:
      return undefined;
  }
}

/** First non-empty trimmed string among the candidates, or `undefined`. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = stringValue(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstNestedString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return findNestedString(source, new Set(keys.map((key) => key.toLowerCase())), 4, new Set());
}

function findNestedString(
  value: unknown,
  keys: ReadonlySet<string>,
  depth: number,
  seen: Set<object>,
): string | undefined {
  if (!isRecord(value) || depth < 0 || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const [key, candidate] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const match = stringValue(candidate);
      if (match) {
        return match;
      }
    }
  }
  for (const candidate of Object.values(value)) {
    const match = findNestedString(candidate, keys, depth - 1, seen);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const joined = value.join(" ").trim();
    return joined || undefined;
  }
  return undefined;
}

function toolMessage(
  name: string,
  summary: string | undefined,
): Omit<AgentMessage, "agent" | "worktreeId" | "tabId"> {
  const id = messageId(`tool:${name}`);
  return {
    id,
    role: "tool",
    toolCalls: [{ id, name, status: "running", ...(summary ? { summary } : {}) }],
    subAgentsActive: /(?:task|agent)/i.test(name) ? 1 : 0,
    ts: Date.now(),
  };
}

function messageId(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`}`;
}

function summaryFromRecord(record: Record<string, unknown>): string | undefined {
  return textFromRecord(record) ?? compactJson(record);
}

/**
 * Human-readable one-liner for a tool call. Prefer the tool's primary arg
 * (command, path, pattern, …) over dumping the whole args object as JSON —
 * mobile chat renders `summary` as the gray activity line.
 */
function toolSummary(tool: string, args: Record<string, unknown>): string | undefined {
  return TOOL_SUMMARIES[tool.toLowerCase()]?.(args) ?? summaryFromRecord(args);
}

const TOOL_SUMMARIES: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  bash: commandSummary,
  shell: commandSummary,
  read: pathSummary,
  write: pathSummary,
  edit: pathSummary,
  apply_patch: pathSummary,
  patch: pathSummary,
  grep: grepSummary,
  glob: (args) => firstString(args.pattern, args.glob, args.path),
  webfetch: (args) => firstString(args.url, args.uri),
  fetch: (args) => firstString(args.url, args.uri),
  websearch: (args) => firstString(args.query, args.q, args.search),
  search: (args) => firstString(args.query, args.q, args.search),
  todowrite: () => "Updating todos",
  todo: () => "Updating todos",
  task: taskSummary,
  agent: taskSummary,
};

function commandSummary(args: Record<string, unknown>): string | undefined {
  return firstString(args.command, args.cmd, args.script);
}

function pathSummary(args: Record<string, unknown>): string | undefined {
  return firstString(args.filePath, args.filepath, args.path, args.file);
}

function grepSummary(args: Record<string, unknown>): string | undefined {
  return firstString(args.pattern, args.query, args.regex) ?? firstString(args.path, args.include);
}

function taskSummary(args: Record<string, unknown>): string | undefined {
  return firstString(args.description, args.prompt, args.text) ?? "Spawning sub-agent";
}

/**
 * Pulls the display prompt + radio labels out of OpenCode's question-tool args
 * (`{ questions: [{ question, header, options: [{ label, description }] }] }`).
 * Returns undefined when the shape is unrecognizable so callers can fall back.
 */
function parseQuestionArgs(
  args: Record<string, unknown>,
): { question: string; options: QuestionOption[] }[] | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : undefined;
  if (!questions || questions.length === 0) {
    // Some builds may pass a single prompt at the top level.
    const single = questionPromptFrom(args);
    return single ? [single] : undefined;
  }
  const parsed = questions.flatMap((item) => {
    const question = isRecord(item) ? questionPromptFrom(item) : undefined;
    return question ? [question] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function questionPromptFrom(
  record: Record<string, unknown>,
): { question: string; options: QuestionOption[] } | undefined {
  const question =
    firstString(record.question, record.header, record.text, record.message, record.prompt) ??
    undefined;
  if (!question) {
    return undefined;
  }
  const options = questionOptions(record.options);
  return { question, options };
}

/** Extracts answer choices from OpenCode `{ label, description }` option objects. */
function questionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: QuestionOption[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      options.push({ label: item.trim() });
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const label = firstString(item.label, item.text, item.value, item.name, item.description);
    if (label) {
      const description = firstString(item.description);
      options.push({ label, ...(description && description !== label ? { description } : {}) });
    }
  }
  return options;
}

function textFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "message", "command", "description", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Joins non-empty text parts from a `chat.message` output (or similar). */
function textFromParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "text") {
      continue;
    }
    if (typeof part.text === "string" && part.text.trim()) {
      chunks.push(part.text.trim());
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function compactJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return undefined;
  }
}
