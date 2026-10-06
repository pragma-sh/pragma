import { object, parseJson, records } from "./transcript";

function option(value: unknown) {
  const entry = object(value);
  if (typeof entry.label !== "string") return [];
  return [
    {
      label: entry.label,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    },
  ];
}

function question(value: unknown) {
  const entry = object(value);
  if (typeof entry.question !== "string" || !entry.question.trim()) return [];
  const options = Array.isArray(entry.options) ? entry.options.flatMap(option) : [];
  return [{ question: entry.question, options }];
}

function request(payload: Record<string, unknown>) {
  const callId = payload.call_id ?? payload.id;
  const questions = parseQuestions(payload.arguments);
  if (!isValidRequest(callId, questions)) return undefined;
  return {
    state: "pending",
    requestId: callId,
    ...(questions.length === 1 ? questions[0] : { questions }),
  };
}

function isValidRequest(callId: unknown, questions: unknown[]): callId is string {
  return typeof callId === "string" && questions.length > 0;
}

function parseQuestions(value: unknown) {
  const args = object(typeof value === "string" ? parseJson(value) : value);
  return Array.isArray(args.questions) ? args.questions.flatMap(question) : [];
}

type Pending = Map<string, NonNullable<ReturnType<typeof request>>>;

const CODE_MODE_CALL = "tools.request_user_input(";

/**
 * Codex 0.153+ runs tools in "code mode": the model writes one `exec` custom
 * tool call whose JavaScript `input` calls `tools.request_user_input({...})`.
 * The argument is the same JSON object the direct function call carried.
 */
export function codeModeArguments(input: unknown): unknown {
  if (typeof input !== "string") return undefined;
  const call = input.indexOf(CODE_MODE_CALL);
  if (call === -1) return undefined;
  const start = input.indexOf("{", call + CODE_MODE_CALL.length);
  const end = start === -1 ? -1 : objectEnd(input, start);
  if (end === -1) return undefined;
  const literal = input.slice(start, end + 1);
  // A JS literal may leave keys unquoted (`{ questions: [...] }`); quote them
  // only as a fallback so string contents of valid JSON are never touched.
  return (
    parseJson(literal) ?? parseJson(literal.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'))
  );
}

/** Index of the brace closing the object opened at `start`, skipping strings. */
function objectEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function updatePending(pending: Pending, payload: Record<string, unknown>) {
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    resolvePending(pending, payload.call_id);
    return;
  }
  if (payload.type === "function_call" && payload.name === "request_user_input") {
    addPending(pending, payload);
    return;
  }
  if (payload.type !== "custom_tool_call") return;
  const args = codeModeArguments(payload.input);
  if (args !== undefined) addPending(pending, { ...payload, arguments: args });
}

function resolvePending(pending: Pending, callId: unknown) {
  if (typeof callId === "string") pending.delete(callId);
}

function addPending(pending: Pending, payload: Record<string, unknown>) {
  const entry = request(payload);
  if (entry) pending.set(entry.requestId, entry);
}

/** Find the most recent unanswered native question in this turn's rollout. */
export async function questionSnapshot(path: string, offset: number) {
  const pending: Pending = new Map();
  for await (const item of records(path, offset)) {
    if (item.type !== "response_item") continue;
    updatePending(pending, object(item.payload));
  }
  return [...pending.values()].at(-1) ?? { state: "none" };
}
