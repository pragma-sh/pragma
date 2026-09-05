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

function updatePending(pending: Pending, payload: Record<string, unknown>) {
  if (payload.type === "function_call_output") {
    resolvePending(pending, payload.call_id);
    return;
  }
  if (payload.type !== "function_call" || payload.name !== "request_user_input") return;
  addPending(pending, payload);
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
