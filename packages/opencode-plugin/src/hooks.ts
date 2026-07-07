import type { Hooks } from "@opencode-ai/plugin";
import { type AgentAttentionKind, type AgentMessage } from "@pragma/sdk";

type ReportKey = "started" | "stopped" | "cleared" | `attention:${AgentAttentionKind}`;
type Environment = Record<string, string | undefined>;
type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type RuntimeEvent = OpencodeEvent | { type: string; properties?: Record<string, unknown> };

/** What a runtime event asks the reporter to do: re-derive status, reset, or nothing. */
type EventAction = "sync" | "clear" | "none";

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

  const EVENT_HANDLERS: Record<string, (event: RuntimeEvent) => EventAction> = {
    "session.status": applySessionStatusEvent,
    "session.idle": applySessionIdleEvent,
    "session.error": applySessionErrorEvent,
    "session.deleted": applySessionDeletedEvent,
    "server.instance.disposed": () => "clear",
    "permission.replied": applyPermissionRepliedEvent,
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
      const action = applyEvent(runtimeEvent);
      if (action === "clear") {
        await clear();
      } else if (action === "sync") {
        await sync();
      }
    },
    "chat.message": async (input) => {
      busy = true;
      await reporter.message({
        id: messageId("chat"),
        role: "user",
        text: textFromRecord(input as Record<string, unknown>),
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
    "tool.execute.before": async (input) => {
      if (input.tool === "question") {
        raiseAttention("question");
      } else {
        busy = true;
      }
      await reporter.message(
        toolMessage(input.tool, summaryFromRecord(input as Record<string, unknown>)),
      );
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

  function applyPermissionRepliedEvent(): EventAction {
    attention = false;
    busy = true;
    return "sync";
  }

  function applyMessagePartEvent(event: RuntimeEvent): EventAction {
    return applyMessagePart(event) ? "sync" : "none";
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
  function applyMessagePart(event: RuntimeEvent): boolean {
    const part = questionPartFromEvent(event);
    if (!part) {
      return false;
    }
    applyQuestionPartState(part);
    return true;
  }

  /** Pulls the `question` tool part out of a `message.part.updated` event, if any. */
  function questionPartFromEvent(event: RuntimeEvent): Record<string, unknown> | undefined {
    const properties = event.properties;
    const part = isRecord(properties) && "part" in properties ? properties.part : undefined;
    if (!isRecord(part) || part.type !== "tool" || part.tool !== "question") {
      return undefined;
    }
    return part;
  }

  /** Updates flags from a question tool part's state: resume when resolved, else raise. */
  function applyQuestionPartState(part: Record<string, unknown>): void {
    const state = isRecord(part.state) ? part.state : undefined;
    const status = state?.status;
    if (status === "completed" || status === "error") {
      attention = false;
      busy = true;
    } else {
      raiseAttention("question");
    }
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

function textFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "message", "command", "description", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function compactJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return undefined;
  }
}
