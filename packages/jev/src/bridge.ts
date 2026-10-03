/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * Where `apps/pragma/src-tauri/src/dev_bridge.rs` publishes itself. Hard-coded
 * to `/tmp` there, so it is hard-coded here too: jev cannot be more portable
 * than the bridge it drives.
 */
const TOKEN_DIR = "/tmp";
const TOKEN_PREFIX = "tauri-dev-bridge-";
const TOKEN_SUFFIX = ".token";

/** Ceiling on one HTTP call. The bridge itself gives up on an eval after 5s. */
const REQUEST_TIMEOUT_MS = 8000;

/** Prefix the bridge puts on an exception it caught while evaluating. */
const EVAL_ERROR_PREFIX = "ERROR: ";

/** What a dev bridge writes to its token file once it is listening. */
export interface BridgeToken {
  port: number;
  token: string;
  pid: number;
}

/** A live dev bridge together with the executable that owns it. */
export interface DevInstance extends BridgeToken {
  exe: string | null;
  uptimeMs: number | null;
}

/** Raised for anything that stops jev from reaching a dev instance. */
export class BridgeError extends Error {
  override name = "BridgeError";
}

/** Raised when JavaScript evaluated in the page threw. */
export class EvalError extends Error {
  override name = "EvalError";
}

/** Parses one token file's contents, or `null` when it is not a bridge token. */
export function parseToken(contents: string): BridgeToken | null {
  try {
    const value = JSON.parse(contents) as Partial<BridgeToken>;
    if (
      typeof value.port === "number" &&
      typeof value.token === "string" &&
      typeof value.pid === "number"
    ) {
      return { port: value.port, token: value.token, pid: value.pid };
    }
  } catch {
    // A half-written or foreign file is simply not a bridge.
  }
  return null;
}

function tokensOnDisk(): BridgeToken[] {
  let names: string[];
  try {
    names = readdirSync(TOKEN_DIR);
  } catch {
    return [];
  }
  const tokens: BridgeToken[] = [];
  for (const name of names) {
    if (!name.startsWith(TOKEN_PREFIX) || !name.endsWith(TOKEN_SUFFIX)) continue;
    try {
      const token = parseToken(readFileSync(join(TOKEN_DIR, name), "utf8"));
      if (token) tokens.push(token);
    } catch {
      // Unreadable: another user's file, or deleted between list and read.
    }
  }
  return tokens;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function post(token: BridgeToken, path: string, body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${token.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token: token.token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function probe(token: BridgeToken): Promise<DevInstance | null> {
  // The bridge never removes its token file when the app is killed, so most
  // files in /tmp are stale. A dead pid is skipped without a network call.
  if (!processAlive(token.pid)) return null;
  try {
    const response = await post(token, "/process", {});
    if (!response.ok) return null;
    const body = (await response.json()) as { tauri?: { exe?: string; uptime_ms?: number } };
    return { ...token, exe: body.tauri?.exe ?? null, uptimeMs: body.tauri?.uptime_ms ?? null };
  } catch {
    return null;
  }
}

/** Every reachable dev bridge on this machine. */
export async function liveInstances(): Promise<DevInstance[]> {
  const found = await Promise.all(tokensOnDisk().map(probe));
  return found.filter((instance): instance is DevInstance => instance !== null);
}

function gitToplevel(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(canonical(root), canonical(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Only Pragma's own binary is driven; any other Tauri dev app is ignored. */
function isPragma(instance: DevInstance): boolean {
  return instance.exe === null || /[/\\]pragma(\.exe)?$/.test(instance.exe);
}

/**
 * Picks which instance to drive. An explicit pid wins. Otherwise the instance
 * built from the checkout containing `cwd` wins, so running jev from a
 * worktree drives that worktree's dev build and never somebody else's. With no
 * match, a single running instance is unambiguous; several are an error.
 */
export function chooseInstance(
  instances: DevInstance[],
  options: { pid?: number; checkout?: string | null },
): DevInstance {
  const candidates = instances.filter(isPragma);
  if (options.pid !== undefined) {
    const match = candidates.find((instance) => instance.pid === options.pid);
    if (!match) throw new BridgeError(`no running Pragma dev instance has pid ${options.pid}`);
    return match;
  }
  if (candidates.length === 0) {
    throw new BridgeError(
      "no running Pragma dev instance found — start one with `bun run dev` and wait for its window",
    );
  }
  const checkout = options.checkout;
  if (checkout) {
    const local = candidates.filter(
      (instance) => instance.exe !== null && isInside(checkout, instance.exe),
    );
    if (local.length > 0) {
      return local.toSorted((a, b) => (a.uptimeMs ?? 0) - (b.uptimeMs ?? 0))[0]!;
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  const list = candidates.map((instance) => `  pid ${instance.pid}  ${instance.exe ?? "?"}`);
  throw new BridgeError(
    `several Pragma dev instances are running and none was built from this checkout; pass --pid:\n${list.join("\n")}`,
  );
}

/** Finds the dev instance to drive, honouring `--pid`. */
export async function resolveInstance(pid?: number): Promise<DevInstance> {
  return chooseInstance(await liveInstances(), { pid, checkout: gitToplevel(process.cwd()) });
}

/**
 * Evaluates `js` in the app's main webview and returns its value. The bridge
 * awaits promises, JSON-encodes objects, and stringifies everything else, so
 * a JSON-looking string is decoded back into a value here.
 */
export async function evaluate(instance: BridgeToken, js: string): Promise<unknown> {
  let response: Response;
  try {
    response = await post(instance, "/eval", { js });
  } catch (error) {
    throw new BridgeError(
      `dev instance pid ${instance.pid} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeError(`bridge answered ${response.status}: ${await response.text()}`);
  }
  const { result } = (await response.json()) as { result: unknown };
  if (typeof result !== "string") return result;
  if (result.startsWith(EVAL_ERROR_PREFIX)) {
    throw new EvalError(result.slice(EVAL_ERROR_PREFIX.length));
  }
  try {
    return JSON.parse(result) as unknown;
  } catch {
    return result;
  }
}

/** POSTs an authenticated JSON request to one of the bridge's endpoints. */
export async function bridgeRequest<T>(
  instance: BridgeToken,
  path: string,
  body: object = {},
): Promise<T> {
  const response = await post(instance, path, body);
  if (!response.ok)
    throw new BridgeError(
      `bridge answered ${response.status} for ${path}: ${await response.text()}`,
    );
  return (await response.json()) as T;
}

/** Drains the Rust log lines the bridge has buffered since the last call. */
export async function drainLogs(instance: BridgeToken): Promise<unknown[]> {
  const body = await bridgeRequest<{ entries?: unknown[] }>(instance, "/logs");
  return body.entries ?? [];
}
