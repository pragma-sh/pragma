// Shared transport for the two things Pragma needs to read out of Grok Build:
// the account's billing/usage snapshot and the model catalog. Both come from a
// short-lived `grok agent stdio` process speaking ACP (JSON-RPC 2.0) — grok's
// documented programmatic entry point — so neither the launcher nor the usage
// provider ever touches `~/.grok/auth.json`. Grok owns its credentials and
// refresh; Pragma never reads or prints a token.
import { runProviderCommand } from "@pragma/plugin/catalog";
import type { PluginContext } from "@pragma/plugin/catalog";

/** Exit status the wrapper uses to say `grok` is not installed. */
const MISSING_STATUS = 20;

/** Request id of the `initialize` handshake, whose result carries the model catalog. */
const INITIALIZE_ID = 1;
/** Request id of the `_x.ai/billing` call. */
const BILLING_ID = 2;

/** Poll interval and bound while Grok finishes the two requested responses. */
const DRAIN_POLL_SECONDS = 0.1;
const DRAIN_POLL_ATTEMPTS = 60;

/**
 * ACP requires the `jsonrpc` member; grok answers `Method not found` for the
 * unprefixed `x.ai/billing` name — the extension methods are only reachable
 * under the ACP-unstable `_` prefix.
 */
const REQUESTS = [
  {
    jsonrpc: "2.0",
    id: INITIALIZE_ID,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  },
  { jsonrpc: "2.0", id: BILLING_ID, method: "_x.ai/billing", params: {} },
];

const REQUEST_INPUT = REQUESTS.map((request) => shellQuote(JSON.stringify(request))).join(" ");
const RESPONSE_WATCHER = `
function is_response(line, id) {
  return line ~ /"jsonrpc"[[:space:]]*:[[:space:]]*"2[.]0"/ &&
    line ~ ("\\"id\\"[[:space:]]*:[[:space:]]*" id "([[:space:]]*[,}])") &&
    (line ~ /"result"[[:space:]]*:/ || line ~ /"error"[[:space:]]*:/)
}
{
  print
  if (is_response($0, ${INITIALIZE_ID})) initialize = 1
  if (is_response($0, ${BILLING_ID})) billing = 1
  if (initialize && billing && !finished) {
    print "" > done
    close(done)
    finished = 1
  }
}`.trim();
const COMMAND =
  `command -v grok >/dev/null 2>&1 || exit ${MISSING_STATUS}; ` +
  `drain_dir=$(mktemp -d) || exit 1; trap 'rm -rf "$drain_dir"' 0; ` +
  `drain_done="$drain_dir/done"; drain_status="$drain_dir/status"; ` +
  `{ printf '%s\\n' ${REQUEST_INPUT}; attempts=0; ` +
  `while [ "$attempts" -lt ${DRAIN_POLL_ATTEMPTS} ] && [ ! -e "$drain_done" ]; do ` +
  `sleep ${DRAIN_POLL_SECONDS}; attempts=$((attempts + 1)); done; } | ` +
  `{ grok agent stdio; printf '%s\\n' "$?" > "$drain_status"; : > "$drain_done"; } | ` +
  `awk -v done="$drain_done" ${shellQuote(RESPONSE_WATCHER)}; ` +
  `IFS= read -r exit_code < "$drain_status" || exit 1; exit "$exit_code"`;

/** One JSON-RPC response line, already narrowed to result-or-error. */
export type AcpResponse =
  | { ok: true; result: unknown }
  | { ok: false; message: string | null }
  | undefined;

/** Result of one `grok agent stdio` round trip. */
export interface AcpSnapshot {
  /** True when `grok` is not on PATH; every field below is then `undefined`. */
  missing: boolean;
  initialize: AcpResponse;
  billing: AcpResponse;
}

/** Runs the ACP handshake plus the billing call and returns both responses. */
export async function readGrokAcp(ctx: PluginContext): Promise<AcpSnapshot> {
  const outcome = await runProviderCommand(ctx, COMMAND, MISSING_STATUS);
  if (outcome.kind === "missing") {
    return { missing: true, initialize: undefined, billing: undefined };
  }
  if (outcome.kind === "failed") {
    throw new Error(outcome.stderr || "Grok ACP request failed");
  }
  return {
    missing: false,
    initialize: findResponse(outcome.stdout, INITIALIZE_ID),
    billing: findResponse(outcome.stdout, BILLING_ID),
  };
}

/**
 * Scans NDJSON output for the response to `id`. Grok interleaves notifications
 * and answers out of order, so lines that fail to parse or carry another id are
 * skipped rather than treated as an error.
 */
export function findResponse(stdout: string, id: number): AcpResponse {
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(message);
    if (record === null || record.id !== id) {
      continue;
    }
    if ("result" in record) {
      return { ok: true, result: record.result };
    }
    return { ok: false, message: asText(asRecord(record.error)?.message) };
  }
  return undefined;
}

/** Single-quotes a value for POSIX `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Narrows an unknown to a plain object, or null.
 *
 * Returning null rather than acting as a type predicate lets callers chain
 * (`asRecord(x)?.y`) through grok's deeply optional payloads without a nested
 * `if` per level.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Returns a trimmed non-empty string, or null. */
export function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Returns a finite number, or null. Grok wraps money values as `{ val }`. */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const record = asRecord(value);
  return record === null ? null : asNumber(record.val);
}
