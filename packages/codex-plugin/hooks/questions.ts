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
function codeModeArguments(input: unknown): unknown {
  const literal = typeof input === "string" ? codeModeLiteral(input) : undefined;
  return literal === undefined ? undefined : parseLooseJson(literal);
}

/** The object literal passed to `tools.request_user_input(`, verbatim. */
function codeModeLiteral(input: string): string | undefined {
  const call = input.indexOf(CODE_MODE_CALL);
  const start = call === -1 ? -1 : input.indexOf("{", call + CODE_MODE_CALL.length);
  const end = start === -1 ? -1 : objectEnd(input, start);
  return end === -1 ? undefined : input.slice(start, end + 1);
}

/**
 * A JS literal may leave keys unquoted (`{ questions: [...] }`); quote them
 * only as a fallback so string contents of valid JSON are never touched.
 */
function parseLooseJson(literal: string): unknown {
  return (
    parseJson(literal) ?? parseJson(literal.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'))
  );
}

/** Where {@link objectEnd} is while scanning: brace depth and any open string. */
interface ScanState {
  depth: number;
  quote: string | undefined;
  escaped: boolean;
}

const QUOTES = new Set(['"', "'", "`"]);

/** Index of the brace closing the object opened at `start`, skipping strings. */
function objectEnd(source: string, start: number): number {
  const state: ScanState = { depth: 0, quote: undefined, escaped: false };
  for (let index = start; index < source.length; index++) {
    if (closesObject(state, source.charAt(index))) return index;
  }
  return -1;
}

/** Advances the scan by one character; true when it closes the outer object. */
function closesObject(state: ScanState, char: string): boolean {
  if (state.quote === undefined) return scanCode(state, char);
  scanQuoted(state, char);
  return false;
}

function scanQuoted(state: ScanState, char: string) {
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  else if (char === state.quote) state.quote = undefined;
}

function scanCode(state: ScanState, char: string): boolean {
  if (QUOTES.has(char)) state.quote = char;
  else if (char === "{") state.depth++;
  else if (char === "}") return --state.depth === 0;
  return false;
}

type PendingUpdate = (pending: Pending, payload: Record<string, unknown>) => void;

const resolveOutput: PendingUpdate = (pending, payload) => resolvePending(pending, payload.call_id);

/** How each rollout `response_item` type changes the set of open questions. */
const PENDING_UPDATES = new Map<unknown, PendingUpdate>([
  ["function_call_output", resolveOutput],
  ["custom_tool_call_output", resolveOutput],
  ["function_call", addFunctionCall],
  ["custom_tool_call", addCodeModeCall],
]);

function updatePending(pending: Pending, payload: Record<string, unknown>) {
  PENDING_UPDATES.get(payload.type)?.(pending, payload);
}

function addFunctionCall(pending: Pending, payload: Record<string, unknown>) {
  if (payload.name === "request_user_input") addPending(pending, payload);
}

function addCodeModeCall(pending: Pending, payload: Record<string, unknown>) {
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
