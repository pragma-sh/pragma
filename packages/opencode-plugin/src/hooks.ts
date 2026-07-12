import type { Hooks } from "@opencode-ai/plugin";
import { type AgentAttentionKind, type AgentMessage, type QuestionOption } from "@pragma/sdk";

type ReportKey = "started" | "stopped" | "cleared" | `attention:${AgentAttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

/** What a runtime event asks the reporter to do: re-derive status, reset, or nothing. */
type EventAction = "sync" | "clear" | "none";

function messageTextKey(messageID: string, partID?: string): string {
  return partID ? `${messageID}:${partID}` : messageID;
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
  /** messageID → role, filled from `message.updated` so text parts can be attributed. */
  const messageRoles = new Map<string, "user" | "assistant">();
  /** partID → OpenCode part type, used to distinguish reasoning deltas from final text. */
  const partTypes = new Map<string, string>();
  /** messageID/partID → accumulated text from `message.part.delta` events. */
  const messageText = new Map<string, string>();

  const EVENT_HANDLERS: Record<string, (event: RuntimeEvent) => EventAction> = {
    "session.status": applySessionStatusEvent,
    "session.idle": applySessionIdleEvent,
    "session.error": applySessionErrorEvent,
    "session.deleted": applySessionDeletedEvent,
    "server.instance.disposed": () => "clear",
    "permission.replied": applyPermissionRepliedEvent,
    "message.updated": applyMessageUpdatedEvent,
    "message.part.updated": applyMessagePartEvent,
  };

  return {
    event: async ({ event }) => {
      const runtimeEvent = event as RuntimeEvent;
      // A permission request: report the command + a requestId so a Pragma
      // approval toast appears, and pin the red dot. opencode exposes no
      // decision-returning plugin hook on the current binary, so the paired
      // watcher answers the verdict with `sendKeys` (see pragma-watcher.ts).
      if (runtimeEvent.type === "permission.asked" || runtimeEvent.type === "permission.updated") {
        await raiseCommandApproval(runtimeEvent);
        return;
      }
      // Assistant (and other) chat content rides on message.* events; report it
      // before the status sync so a trailing idle still carries the reply.
      if (
        runtimeEvent.type === "message.updated" ||
        runtimeEvent.type === "message.part.updated" ||
        runtimeEvent.type === "message.part.delta"
      ) {
        await reportChatContent(runtimeEvent);
      }
      const action = applyEvent(runtimeEvent);
      if (action === "clear") {
        await clear();
      } else if (action === "sync") {
        await sync();
      }
    },
    "chat.message": async (_input, output) => {
      busy = true;
      const text =
        textFromParts(output.parts) ??
        textFromRecord(output.message as unknown as Record<string, unknown>);
      await reporter.message({
        id: messageId("chat"),
        role: "user",
        ...(text ? { text } : {}),
        subAgentsActive: 0,
        ts: Date.now(),
      });
      await sync();
    },
    "command.execute.before": async (input) => {
      busy = true;
      await reporter.message(
        toolMessage("command", summaryFromRecord(input as Record<string, unknown>)),
      );
      await sync();
    },
    "tool.execute.before": async (input, output) => {
      const args = isRecord(output?.args) ? output.args : {};
      if (input.tool === "question") {
        await raiseQuestionAttention(
          args,
          typeof input.callID === "string" ? input.callID : undefined,
        );
        // Surface a short human line in the transcript — never the raw args JSON.
        const parsed = parseQuestionArgs(args);
        await reporter.message(toolMessage("question", parsed?.prompt ?? "Waiting for an answer"));
        return;
      }
      busy = true;
      await reporter.message(toolMessage(input.tool, toolSummary(input.tool, args)));
      await sync();
    },
    "permission.ask": async (input) => {
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

  function raiseAttention(kind: AgentAttentionKind): void {
    attention = true;
    attentionKind = kind;
  }

  /**
   * Resets all status and removes the tab's indicator entirely (the agent quit
   * or its turn was aborted — there is no result to "go look" at). Distinct from
   * `stopped`/`done`, which leaves a green dot.
   */
  async function clear(): Promise<void> {
    busy = false;
    attention = false;
    if (lastReported === "cleared") {
      return;
    }
    lastReported = "cleared";
    await reporter.cleared();
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
      await reporter.started();
    } else if (next === "stopped") {
      await reporter.stopped();
    } else {
      await reporter.attention(attentionKind);
    }
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

  function applySessionIdleEvent(): EventAction {
    busy = false;
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
    return "sync";
  }

  function applySessionDeletedEvent(): EventAction {
    busy = false;
    attention = false;
    return "sync";
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
    await reporter.attentionCommand(commandFromPermission(source), permissionRequestId());
  }

  /**
   * Reports a question attention with the parsed prompt + choices. Pins
   * `lastReported` so a later generic `sync` does not re-emit a bare
   * `attention:question` that would drop the question text/options.
   */
  async function raiseQuestionAttention(
    args: Record<string, unknown>,
    callId: string | undefined,
  ): Promise<void> {
    const parsed = parseQuestionArgs(args);
    attention = true;
    attentionKind = "question";
    lastReported = "attention:question";
    await reporter.attentionQuestion(
      parsed?.prompt ?? "The agent is asking a question",
      parsed?.options ?? [],
      callId ? `opencode-question-${callId}` : permissionRequestId(),
    );
  }

  function applyPermissionRepliedEvent(): EventAction {
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

  /**
   * Surfaces chat content from message.* events into Pragma. Status flags stay
   * in the sync path; this only publishes {@link PragmaReporter.message}.
   */
  async function reportChatContent(event: RuntimeEvent): Promise<void> {
    if (event.type === "message.updated") {
      rememberMessageRole(event);
      return;
    }
    if (event.type === "message.part.delta") {
      await reportChatDelta(event);
      return;
    }
    if (event.type !== "message.part.updated") {
      return;
    }
    const part = partFromEvent(event);
    if (!part) {
      return;
    }
    const partID = typeof part.id === "string" ? part.id : undefined;
    const partType = typeof part.type === "string" ? part.type : undefined;
    if (partID && partType) partTypes.set(partID, partType);
    if (partType !== "text" && partType !== "reasoning") return;
    const messageID = typeof part.messageID === "string" ? part.messageID : undefined;
    // OpenCode can emit an assistant text part before its message.updated role
    // event. Only suppress a part once we positively know it belongs to a user;
    // chat.message already reports those prompts.
    if (!messageID || messageRoles.get(messageID) === "user") {
      return;
    }
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (!text) {
      return;
    }
    const key = messageTextKey(messageID, partID);
    messageText.set(key, text);
    await reportAssistantText(messageID, text, partType, partID);
  }

  /** Accumulates OpenCode's incremental text event and publishes a growing snapshot. */
  async function reportChatDelta(event: RuntimeEvent): Promise<void> {
    const properties = event.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
    const partID = typeof properties.partID === "string" ? properties.partID : undefined;
    const partType = partID ? partTypes.get(partID) : undefined;
    if (
      !messageID ||
      messageRoles.get(messageID) === "user" ||
      (properties.field !== undefined && properties.field !== "text") ||
      typeof properties.delta !== "string" ||
      !properties.delta
    ) {
      return;
    }
    const key = messageTextKey(messageID, partID);
    const text = `${messageText.get(key) ?? ""}${properties.delta}`;
    messageText.set(key, text);
    await reportAssistantText(messageID, text, partType, partID);
  }

  /** Reports one assistant text snapshot under its stable transcript id. */
  async function reportAssistantText(
    messageID: string,
    text: string,
    partType?: string,
    partID?: string,
  ): Promise<void> {
    const isReasoning = partType === "reasoning";
    await reporter.message({
      id: isReasoning ? `reasoning:${messageID}:${partID ?? "part"}` : `assistant:${messageID}`,
      role: isReasoning ? "system" : "assistant",
      text,
      subAgentsActive: 0,
      ts: Date.now(),
    });
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
    const state = isRecord(part.state) ? part.state : undefined;
    const status = state?.status;
    if (status === "completed" || status === "error") {
      attention = false;
      busy = true;
      return;
    }
    // Prefer the structured report (prompt + options) when the part carries
    // tool input; fall back to a bare attention flag when it doesn't.
    const input = isRecord(state?.input)
      ? state.input
      : isRecord(part.input)
        ? part.input
        : undefined;
    if (input) {
      void raiseQuestionAttention(input, typeof part.callID === "string" ? part.callID : undefined);
      return;
    }
    raiseAttention("question");
  }
}

export type { Environment };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const name = tool.toLowerCase();
  switch (name) {
    case "bash":
    case "shell":
      return firstString(args.command, args.cmd, args.script) ?? summaryFromRecord(args);
    case "read":
    case "write":
    case "edit":
    case "apply_patch":
    case "patch":
      return (
        firstString(args.filePath, args.filepath, args.path, args.file) ?? summaryFromRecord(args)
      );
    case "grep":
      return (
        firstString(args.pattern, args.query, args.regex) ??
        firstString(args.path, args.include) ??
        summaryFromRecord(args)
      );
    case "glob":
      return firstString(args.pattern, args.glob, args.path) ?? summaryFromRecord(args);
    case "webfetch":
    case "fetch":
      return firstString(args.url, args.uri) ?? summaryFromRecord(args);
    case "websearch":
    case "search":
      return firstString(args.query, args.q, args.search) ?? summaryFromRecord(args);
    case "todowrite":
    case "todo":
      return "Updating todos";
    case "task":
    case "agent":
      return firstString(args.description, args.prompt, args.text) ?? "Spawning sub-agent";
    default:
      return summaryFromRecord(args);
  }
}

/**
 * Pulls the display prompt + radio labels out of OpenCode's question-tool args
 * (`{ questions: [{ question, header, options: [{ label, description }] }] }`).
 * Returns undefined when the shape is unrecognizable so callers can fall back.
 */
function parseQuestionArgs(
  args: Record<string, unknown>,
): { prompt: string; options: QuestionOption[] } | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : undefined;
  if (!questions || questions.length === 0) {
    // Some builds may pass a single prompt at the top level.
    const single = questionPromptFrom(args);
    return single;
  }
  const prompts = questions.flatMap((item) => {
    const parsed = isRecord(item) ? questionPromptFrom(item) : undefined;
    return parsed ? [parsed] : [];
  });
  if (prompts.length === 0) {
    return undefined;
  }
  // Multiple questions collapse into one attention card: join prompts, keep
  // the first question's options (mobile UI is single-select today).
  const first = prompts[0];
  if (!first) {
    return undefined;
  }
  return {
    prompt: prompts.map((p) => p.prompt).join("\n\n"),
    options: first.options,
  };
}

function questionPromptFrom(
  record: Record<string, unknown>,
): { prompt: string; options: QuestionOption[] } | undefined {
  const prompt =
    firstString(record.question, record.header, record.text, record.message, record.prompt) ??
    undefined;
  if (!prompt) {
    return undefined;
  }
  const options = questionOptions(record.options);
  return { prompt, options };
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
