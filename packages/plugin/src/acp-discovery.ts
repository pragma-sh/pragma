import type { AgentSlashCommand } from "./agent";
import type { PluginContext } from "./types";

/**
 * How to start a tool's Agent Client Protocol server on stdio, e.g.
 * `["opencode", "acp"]` or `["kimi", "acp"]`. ACP agents announce their slash
 * commands — built-ins, custom commands, and skills — in an
 * `available_commands_update` right after `session/new`, which makes it the
 * tool's own authoritative list rather than a guess at its directories.
 */
export interface AcpCommandSource {
  /** Argv; a `{tmp}` in an argument becomes a scratch directory removed afterwards. */
  command: string[];
  /** Seconds to wait for the first command list. Defaults to 30. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
/** How long a discovered list is served before it is refreshed in the background. */
export const ACP_COMMANDS_TTL_MS: number = 5 * 60_000;
/** Probes allowed at once: each starts a whole agent, and a catalog asks for many. */
const MAX_CONCURRENT_PROBES = 2;

/** Extra time to keep reading after the first update; some agents send several. */
const SETTLE_SECONDS = "1.5";
const UPDATE_MARKER = "available_commands_update";

interface CachedCommands {
  commands: AgentSlashCommand[];
  at: number;
}

interface DiscoveryState {
  /** Discovered lists per project + command line. */
  cache: Map<string, CachedCommands>;
  /** Probes in flight, so concurrent callers share one instead of starting the tool twice. */
  inflight: Map<string, Promise<AgentSlashCommand[]>>;
  running: number;
  waiting: (() => void)[];
}

/**
 * Process-wide state. Every plugin bundle inlines its own copy of this module,
 * so module-level state would give each plugin its own cache and its own
 * concurrency limit — ten tools would still start at once. One `globalThis`
 * slot makes the limit and the cache hold across every loaded plugin.
 */
const STATE_KEY = Symbol.for("pragma.acpDiscovery");
const state: DiscoveryState = ((globalThis as Record<symbol, DiscoveryState | undefined>)[
  STATE_KEY
] ??= { cache: new Map(), inflight: new Map(), running: 0, waiting: [] });
const { cache, inflight } = state;

/**
 * Starts the tool's ACP server in the project, opens a session, and returns the
 * slash commands it announces (the last update wins). A list younger than
 * {@link ACP_COMMANDS_TTL_MS} is returned from cache; an older one is returned
 * too while a refresh runs in the background, so only the very first lookup
 * per project waits for the tool to start. An empty or failed probe is never
 * cached — the next lookup tries again. Resolves to an empty list when the tool
 * is missing, the host has no POSIX shell, or no update arrives in time.
 */
export async function discoverAcpSlashCommands(
  ctx: PluginContext<unknown>,
  source: AcpCommandSource,
): Promise<AgentSlashCommand[]> {
  const cwd = ctx.project?.path ?? "/tmp";
  const key = `${cwd}\0${source.command.join("\0")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ACP_COMMANDS_TTL_MS) return cached.commands;
  const probe = inflight.get(key) ?? startProbe(ctx, source, cwd, key);
  return cached ? cached.commands : probe;
}

function startProbe(
  ctx: PluginContext<unknown>,
  source: AcpCommandSource,
  cwd: string,
  key: string,
): Promise<AgentSlashCommand[]> {
  const probe = withProbeSlot(async () => {
    const [result] = await ctx.sdk.exec.run({ cwd, commands: [acpCommandsScript(source)] });
    return result?.status === 0 ? parseAcpCommands(result.stdout) : [];
  })
    .catch(() => [] as AgentSlashCommand[])
    .then((commands) => {
      if (commands.length > 0) cache.set(key, { commands, at: Date.now() });
      return commands;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, probe);
  return probe;
}

async function withProbeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (state.running >= MAX_CONCURRENT_PROBES) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.running += 1;
  try {
    return await work();
  } finally {
    state.running -= 1;
    state.waiting.shift()?.();
  }
}

/**
 * The POSIX `sh` program: feeds `initialize`, then `session/new` once the
 * handshake answers, through a FIFO that stays open until the command list has
 * settled; then stops the agent and prints the last update line.
 */
export function acpCommandsScript(source: AcpCommandSource): string {
  const ticks = Math.round((source.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 10);
  const [binary] = source.command;
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  return [
    `command -v ${shellQuote(binary ?? "")} >/dev/null 2>&1 || exit 0`,
    "work=$(mktemp -d) || exit 0",
    `trap 'rm -rf "$work"' 0`,
    'mkfifo "$work/in" || exit 0',
    ': >"$work/out"',
    "{",
    `  printf '%s\\n' ${shellQuote(initialize)}`,
    "  n=0",
    `  while ! grep -q '"id":1' "$work/out" && [ ! -e "$work/done" ] && [ "$n" -lt ${ticks} ]; do sleep 0.1; n=$((n + 1)); done`,
    `  printf '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"%s","mcpServers":[]}}\\n' "$PWD"`,
    `  while [ ! -e "$work/done" ] && [ "$n" -lt ${ticks * 2} ]; do sleep 0.1; n=$((n + 1)); done`,
    '} >"$work/in" &',
    "writer=$!",
    `${source.command.map(shellArg).join(" ")} <"$work/in" >"$work/out" 2>/dev/null &`,
    "agent=$!",
    "n=0",
    `while [ "$n" -lt ${ticks} ]; do`,
    `  if grep -q ${UPDATE_MARKER} "$work/out"; then sleep ${SETTLE_SECONDS}; break; fi`,
    "  sleep 0.1; n=$((n + 1))",
    "done",
    ': >"$work/done"',
    'kill "$agent" 2>/dev/null',
    'wait "$writer" 2>/dev/null',
    `grep ${UPDATE_MARKER} "$work/out" | tail -n 1`,
    "exit 0",
  ].join("\n");
}

/** Reads slash commands from the last `available_commands_update` line in `stdout`. */
export function parseAcpCommands(stdout: string): AgentSlashCommand[] {
  let commands: AgentSlashCommand[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(UPDATE_MARKER)) continue;
    const parsed = updateCommands(line);
    if (parsed) commands = parsed;
  }
  return commands;
}

function updateCommands(line: string): AgentSlashCommand[] | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  const update = record(record(record(message)?.params)?.update);
  if (update?.sessionUpdate !== UPDATE_MARKER || !Array.isArray(update.availableCommands)) {
    return null;
  }
  return update.availableCommands.flatMap((entry) => {
    const command = acpCommand(entry);
    return command ? [command] : [];
  });
}

/** One `availableCommands` entry as a slash command, or `null` when it has no name. */
function acpCommand(entry: unknown): AgentSlashCommand | null {
  const command = record(entry);
  const name = text(command?.name).replace(/^\//, "");
  if (!name) return null;
  const description = text(command?.description);
  const argumentHint = text(record(command?.input)?.hint);
  return {
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Quotes one argv token, expanding `{tmp}` to the run's scratch directory. */
function shellArg(value: string): string {
  return value
    .split("{tmp}")
    .map((part) => (part ? shellQuote(part) : ""))
    .join('"$work/tmp"');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
