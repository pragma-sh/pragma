// Shared transport for the two things Pragma needs to read out of Junie: the
// launcher's model catalog and the account's quota. Both come from a
// short-lived `junie --acp=true` process speaking ACP (JSON-RPC 2.0) — Junie's
// documented programmatic entry point — so neither the launcher nor the usage
// provider ever reads Junie's credentials. Junie owns them and refreshes them
// itself; Pragma never sees a token.
//
// Unlike a single-shot extension method, both answers require a *session*:
// `session/new` returns the model catalog as ACP config options, and `/usage`
// is a session slash command whose reply arrives as an `agent_message_chunk`
// notification. The session id is only known after `session/new` answers, so
// the shell below keeps Junie's stdin open through a FIFO and feeds the prompt
// back once it has read the id. `--cache-dir` points Junie's caches at a
// throwaway directory so these probe sessions leave nothing behind but an empty
// session folder (they never reach `sessions/index.jsonl`, so they do not show
// up in `junie --resume`).
import type { PluginContext } from "@pragma/plugin/catalog";

/** Exit status the wrapper uses to say `junie` is not installed. */
const MISSING_STATUS = 20;

/** Request id of the `initialize` handshake. */
const INITIALIZE_ID = 1;
/** Request id of `session/new`, whose result carries the model catalog. */
const SESSION_ID = 2;
/** Request id of the `/usage` prompt. */
const PROMPT_ID = 3;

/** Poll cadence and bound the shell uses while waiting on Junie. */
const POLL_SECONDS = "0.1";
const POLL_ATTEMPTS = 900;

/** One JSON-RPC response line, already narrowed to result-or-error. */
export type AcpResponse =
  | { ok: true; result: unknown }
  | { ok: false; message: string | null }
  | undefined;

/** Result of one `junie --acp=true` round trip. */
export interface AcpSnapshot {
  /** True when `junie` is not on PATH; every field below is then `undefined`. */
  missing: boolean;
  /** The `session/new` response, whose `configOptions` hold the model catalog. */
  session: AcpResponse;
  /** Concatenated assistant text of the `/usage` reply, or null when not requested. */
  usageText: string | null;
}

/**
 * Runs the ACP handshake and returns the session response, optionally following
 * it with the `/usage` slash command.
 */
export async function readJunieAcp(
  ctx: PluginContext,
  options: { usage: boolean },
): Promise<AcpSnapshot> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [buildCommand(options.usage)] });
  if (result?.status === MISSING_STATUS) {
    return { missing: true, session: undefined, usageText: null };
  }
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "Junie ACP request failed");
  }
  return {
    missing: false,
    session: findResponse(result.stdout, SESSION_ID),
    usageText: options.usage ? collectAgentText(result.stdout) : null,
  };
}

/**
 * Builds the POSIX `sh` program that drives one ACP conversation.
 *
 * A FIFO carries Junie's stdin so the writer can stay open while the reader
 * decides what to send next: the prompt request is written to `$work/next` by
 * the reader as soon as `session/new` answers, and the writer forwards it. The
 * conversation ends when the reader sees the response it is waiting for, which
 * closes the FIFO and makes Junie exit on EOF.
 */
function buildCommand(usage: boolean): string {
  const finalId = usage ? PROMPT_ID : SESSION_ID;
  return [
    `command -v junie >/dev/null 2>&1 || exit ${MISSING_STATUS};`,
    "work=$(mktemp -d) || exit 1;",
    `trap 'rm -rf "$work"' 0;`,
    'mkfifo "$work/in" || exit 1;',
    "{",
    `printf '%s\\n' ${shellQuote(request(INITIALIZE_ID, "initialize", { protocolVersion: 1, clientCapabilities: {} }))};`,
    `printf '%s\\n' '{"jsonrpc":"2.0","id":${SESSION_ID},"method":"session/new","params":{"cwd":"'"$PWD"'","mcpServers":[]}}';`,
    ...(usage
      ? [
          "n=0;",
          `while [ ! -s "$work/next" ] && [ ! -e "$work/done" ] && [ "$n" -lt ${POLL_ATTEMPTS} ]; do sleep ${POLL_SECONDS}; n=$((n + 1)); done;`,
          '[ -s "$work/next" ] && cat "$work/next";',
        ]
      : []),
    "n=0;",
    `while [ ! -e "$work/done" ] && [ "$n" -lt ${POLL_ATTEMPTS} ]; do sleep ${POLL_SECONDS}; n=$((n + 1)); done;`,
    '} >"$work/in" &',
    'junie --acp=true --skip-update-check --cache-dir "$work/cache" <"$work/in" 2>/dev/null |',
    "while IFS= read -r line; do",
    `printf '%s\\n' "$line";`,
    ...(usage
      ? [
          `case "$line" in *'"sessionId":"'*)`,
          'if [ ! -s "$work/next" ]; then',
          `sid=$(printf '%s' "$line" | sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' | head -n 1);`,
          'if [ -n "$sid" ]; then',
          `printf '{"jsonrpc":"2.0","id":${PROMPT_ID},"method":"session/prompt","params":{"sessionId":"%s","prompt":[{"type":"text","text":"/usage"}]}}\\n' "$sid" >"$work/next";`,
          "fi;",
          "fi;",
          ";; esac;",
        ]
      : []),
    `case "$line" in *'"id":${finalId}'*) : >"$work/done" ;; esac;`,
    "done",
  ].join(" ");
}

/** Builds one JSON-RPC request line. */
function request(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/**
 * Scans NDJSON output for the response to `id`. Junie interleaves notifications
 * and answers, so lines that fail to parse or carry another id are skipped
 * rather than treated as an error.
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

/** Concatenates every `agent_message_chunk` notification in an ACP stream. */
export function collectAgentText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const update = asRecord(asRecord(asRecord(message)?.params)?.update);
    if (update?.sessionUpdate !== "agent_message_chunk") {
      continue;
    }
    const text = asText(asRecord(update.content)?.text);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.join("");
}

/** Single-quotes a value for POSIX `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Narrows an unknown to a plain object, or null.
 *
 * Returning null rather than acting as a type predicate lets callers chain
 * (`asRecord(x)?.y`) through Junie's deeply optional payloads without a nested
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
