import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Narrow optional JSON objects without trusting rollout or hook payloads. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parse optional JSON, tolerating incomplete rollout lines. */
export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Stream complete rollout records from a turn's starting byte offset. */
export async function* records(path: string, offset = 0) {
  const lines = createInterface({
    input: createReadStream(path, { start: offset }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) yield object(parseJson(line));
}

/** Read only the latest context belonging to the requested turn. */
export async function approvalReviewer(path: string, turnId: string): Promise<unknown> {
  if (!turnId) return undefined;
  let reviewer: unknown;
  for await (const item of records(path)) {
    const context = turnContext(item, turnId);
    if (context) reviewer = context.approvals_reviewer;
  }
  return reviewer;
}

function turnContext(item: Record<string, unknown>, turnId: string) {
  const payload = object(item.payload);
  return item.type === "turn_context" && payload.turn_id === turnId ? payload : undefined;
}
