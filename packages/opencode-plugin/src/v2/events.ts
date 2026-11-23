/**
 * Translates OpenCode v2 events into the runtime-event shape the shared state
 * machine in `../hooks.ts` consumes.
 *
 * v2 events are `{ type, data }` with new names (`session.execution.*`,
 * `form.*`, `session.text.*`), while the state machine was built against v1's
 * `{ type, properties }`. Translating at this edge keeps one state machine for
 * both APIs instead of two that drift apart. Unknown events translate to
 * nothing.
 */

/** A v1-shaped runtime event, as `createPragmaOpencodeHooks().event` expects. */
export interface RuntimeEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** The fields of a v2 event this translator reads. */
export interface V2Event {
  type: string;
  data?: unknown;
}

type Translator = (data: Record<string, unknown>) => RuntimeEvent[];

/** v2 permission actions whose resources are the shell command being approved. */
const SHELL_ACTIONS = new Set(["bash", "shell"]);
/** v2 permission actions whose first resource is the file being touched. */
const FILE_ACTIONS = new Set(["read", "write", "edit", "patch"]);

const TRANSLATORS: Record<string, Translator> = {
  "session.created": (data) => [
    runtime("session.created", {
      info: {
        id: data.sessionID,
        ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
        ...(typeof data.title === "string" ? { title: data.title } : {}),
      },
    }),
  ],
  // A rename carries no parentID; the state machine keeps child classification
  // from `session.created`, exactly as for v1's partial `session.updated`.
  "session.renamed": (data) => [
    runtime("session.updated", { info: { id: data.sessionID, title: data.title } }),
  ],
  "session.status": (data) => [runtime("session.status", data)],
  "session.idle": (data) => [runtime("session.idle", data)],
  "session.execution.started": (data) => [
    runtime("session.status", { sessionID: data.sessionID, status: { type: "busy" } }),
  ],
  "session.execution.succeeded": (data) => [runtime("session.idle", data)],
  "session.execution.failed": (data) => [
    runtime("session.error", { sessionID: data.sessionID, error: data.error }),
  ],
  "session.execution.interrupted": translateInterrupted,
  "session.deleted": (data) => [runtime("session.deleted", data)],
  "session.shell.started": (data) => shellEvent("session.next.shell.started", data),
  "session.shell.ended": (data) => shellEvent("session.next.shell.ended", data),
  "permission.asked": (data) => [runtime("permission.asked", permissionProperties(data))],
  "permission.replied": (data) => [runtime("permission.replied", data)],
  "form.created": translateFormCreated,
  "form.replied": (data) => [
    runtime("question.replied", { sessionID: data.sessionID, requestID: data.id }),
  ],
  "form.cancelled": (data) => [
    runtime("question.rejected", { sessionID: data.sessionID, requestID: data.id }),
  ],
  "session.text.started": (data) => [streamPart(data, "text", "")],
  "session.text.delta": (data) => [streamDelta(data, "text")],
  "session.text.ended": (data) => [streamPart(data, "text", data.text)],
  "session.reasoning.started": (data) => [streamPart(data, "reasoning", "")],
  "session.reasoning.delta": (data) => [streamDelta(data, "reasoning")],
  "session.reasoning.ended": (data) => [streamPart(data, "reasoning", data.text)],
  "global.disposed": () => [runtime("server.instance.disposed", {})],
};

/** Translates one v2 event; returns no events for types Pragma does not track. */
export function runtimeEventsFromV2(event: V2Event): RuntimeEvent[] {
  const translate = TRANSLATORS[event.type];
  return translate ? translate(isRecord(event.data) ? event.data : {}) : [];
}

function runtime(type: string, properties: Record<string, unknown>): RuntimeEvent {
  return { type, properties };
}

/**
 * A user interrupt (esc-esc) or shutdown has no result to look at, so it maps
 * to v1's abort error, which clears the indicator. A superseded or timed-out
 * run simply ends.
 */
function translateInterrupted(data: Record<string, unknown>): RuntimeEvent[] {
  if (data.reason === "user" || data.reason === "shutdown") {
    return [
      runtime("session.error", {
        sessionID: data.sessionID,
        error: { name: "MessageAbortedError" },
      }),
    ];
  }
  return [runtime("session.idle", { sessionID: data.sessionID })];
}

function shellEvent(type: string, data: Record<string, unknown>): RuntimeEvent[] {
  const shell = isRecord(data.shell) ? data.shell : {};
  return [runtime(type, { sessionID: data.sessionID, callID: shell.id })];
}

/**
 * v2 permissions are `{ action, resources, metadata, message }`. Expose them
 * under the fields `commandFromPermission` already probes, preferring a command
 * or path the tool put in `metadata` over the matched resource patterns.
 */
function permissionProperties(data: Record<string, unknown>): Record<string, unknown> {
  const action = stringField(data.action);
  const resources = stringArray(data.resources);
  const properties: Record<string, unknown> = { ...data };
  if (action) properties.type = action;
  if (typeof data.message === "string") properties.title = data.message;
  if (resources.length > 0) {
    properties.pattern = resources.join(" ");
    Object.assign(properties, resourceTarget(action, resources, data.metadata));
  }
  return properties;
}

/** The command or file a permission's resources name, unless `metadata` already does. */
function resourceTarget(
  action: string | undefined,
  resources: readonly string[],
  metadata: unknown,
): Record<string, string> {
  const known = isRecord(metadata) ? metadata : {};
  const normalized = action?.toLowerCase() ?? "";
  if (SHELL_ACTIONS.has(normalized) && typeof known.command !== "string") {
    return { command: resources.join(" ") };
  }
  if (FILE_ACTIONS.has(normalized) && typeof known.filePath !== "string") {
    return { filePath: resources[0] ?? "" };
  }
  return {};
}

/**
 * v2 asks the user through forms (the question tool included): each field is
 * one question, and a field's options are its answer choices. A form with no
 * askable field still raises one question titled after the form.
 */
function translateFormCreated(data: Record<string, unknown>): RuntimeEvent[] {
  const form = isRecord(data.form) ? data.form : undefined;
  if (!form || typeof form.id !== "string") {
    return [];
  }
  const title = typeof form.title === "string" ? form.title : "";
  const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
  const questions = fields
    .filter((field) => field.hidden !== true)
    .map((field) => formFieldQuestion(field, title));
  return [
    runtime("question.asked", {
      id: form.id,
      sessionID: form.sessionID,
      questions: questions.length > 0 ? questions : [{ question: title }],
    }),
  ];
}

function formFieldQuestion(
  field: Record<string, unknown>,
  formTitle: string,
): Record<string, unknown> {
  // The question tool puts its short `header` ("Choice", "Color") in the
  // field's title and the question itself in the description, so the
  // description is the prompt whenever there is one. A field with only a
  // title (a plain form input) is asked by that title.
  const question =
    stringField(field.description) ?? stringField(field.title) ?? (formTitle || "Answer needed");
  const options = Array.isArray(field.options)
    ? field.options.filter(isRecord).map((option) => formOption(option))
    : field.type === "boolean"
      ? [{ label: "Yes" }, { label: "No" }]
      : [];
  return { question, options };
}

function formOption(option: Record<string, unknown>): Record<string, unknown> {
  const choice: Record<string, unknown> = { label: option.label };
  if (typeof option.description === "string") choice.description = option.description;
  return choice;
}

/** Stable per-stream part id: v2 numbers text/reasoning streams by ordinal. */
function streamPartId(data: Record<string, unknown>, kind: "text" | "reasoning"): string {
  return `${kind}:${String(data.ordinal ?? 0)}`;
}

function streamPart(
  data: Record<string, unknown>,
  kind: "text" | "reasoning",
  text: unknown,
): RuntimeEvent {
  return runtime("message.part.updated", {
    part: {
      id: streamPartId(data, kind),
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      type: kind,
      text: typeof text === "string" ? text : "",
    },
  });
}

function streamDelta(data: Record<string, unknown>, kind: "text" | "reasoning"): RuntimeEvent {
  return runtime("message.part.delta", {
    sessionID: data.sessionID,
    messageID: data.assistantMessageID,
    partID: streamPartId(data, kind),
    field: "text",
    delta: data.delta,
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
