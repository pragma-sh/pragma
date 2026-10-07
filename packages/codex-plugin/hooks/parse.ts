import { readFileSync, writeFileSync } from "node:fs";

import { questionSnapshot } from "./questions";
import { approvalReviewer, object, parseJson, records } from "./transcript";

const [operation, ...args] = process.argv.slice(2);
const arg = (index: number) => args[index] ?? "";
const print = (value: unknown) => {
  if (value !== undefined) console.log(JSON.stringify(value));
};
const input = () => object(parseJson(readFileSync(0, "utf8")));

function field() {
  let value: unknown = input();
  for (const key of arg(0).split(".")) value = object(value)[key];
  if (operation === "json-value") print(value);
  else if (typeof value === "string") process.stdout.write(value);
}

function contentMessage() {
  print({
    id: arg(0),
    role: arg(1),
    text: arg(2),
    subAgentsActive: Number(arg(3)),
    ts: Number(arg(4)),
  });
}

function extractCommand() {
  const payload = input();
  const tool = payload.tool_name || "Codex tool";
  console.log(`${tool} ${commandDetail(payload.tool_input) ?? ""}`.trim());
}

function commandDetail(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") return toolInput;
  const fields = object(toolInput);
  const detail = fields.command ?? fields.description;
  return typeof detail === "string" ? detail : JSON.stringify(toolInput);
}

function sentCount(path: string): number {
  try {
    return Number(readFileSync(path, "utf8")) || 0;
  } catch {
    return 0;
  }
}

/**
 * Completed assistant text from one rollout record. Codex 0.153+ records an
 * `item_completed` event whose item is an `AgentMessage` (text in `content[]`);
 * earlier versions wrote a flat `agent_message` event instead.
 */
function assistantText(item: Record<string, unknown>): string | undefined {
  if (item.type !== "event_msg") return undefined;
  const payload = object(item.payload);
  return payload.type === "agent_message"
    ? nonblankText(payload.message)
    : completedMessageText(payload);
}

/** Text of a Codex 0.153+ `item_completed` event carrying an `AgentMessage`. */
function completedMessageText(payload: Record<string, unknown>): string | undefined {
  const completed = object(payload.item);
  if (payload.type !== "item_completed" || completed.type !== "AgentMessage") return undefined;
  return nonblankText(contentText(completed.content));
}

/** The concatenated text parts of an `AgentMessage`'s `content[]`. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => object(part).text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function nonblankText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function syncMessages() {
  const sent = sentCount(arg(2));
  let index = 0;
  for await (const item of records(arg(0), Number(arg(1)))) {
    const text = assistantText(item);
    if (text === undefined) continue;
    if (index >= sent)
      print({
        id: `${arg(3)}-${String(index).padStart(3, "0")}`,
        role: "assistant",
        text,
        subAgentsActive: Number(arg(4)),
        ts: Number(arg(5)),
      });
    index++;
  }
  writeFileSync(arg(2), String(index));
}

const operations: Record<string, () => unknown> = {
  "json-field": field,
  "json-value": field,
  "content-message": contentMessage,
  "extract-command": extractCommand,
  "sync-messages": syncMessages,
  "question-snapshot": async () => print(await questionSnapshot(arg(0), Number(arg(1)))),
  "approval-reviewer": async () => {
    const reviewer = await approvalReviewer(arg(0), arg(1));
    if (typeof reviewer === "string") process.stdout.write(reviewer);
  },
};

try {
  await operations[operation ?? ""]?.();
} catch {
  // Hooks fail open on unavailable/malformed input; never disrupt Codex.
}
