/** `pragma-watch` host-side sidecar for plugin watcher instances. */
import { pathToFileURL } from "node:url";

import { PragmaClient, type AgentMessage } from "@pragma-sh/sdk";

import { interruptKeysFor } from "./interrupt";
import { parseLaunchSelection } from "./selection";
import { attachSessionEvents, waitForExit } from "./session-attach";

interface Args {
  pluginId: string;
  pluginMain: string;
  agentId: string;
  watcherAgent: string;
  config: string;
  sessionId: string;
  tabId: string;
  worktreeId: string;
  gatewayUrl: string;
  gatewayToken: string;
  /** JSON launch selection; passed only to a watcher started with a fresh launch. */
  selection?: string;
}

interface PluginModule {
  default?: {
    watchers?: Array<{
      agent: string;
      watch: (ctx: unknown) => void | Promise<void>;
      interruptKeys?: unknown;
    }>;
  };
}

function flag(args: string[], name: keyof Args): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (name: keyof Args): string => {
    const value = flag(argv, name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  return {
    pluginId: get("pluginId"),
    pluginMain: get("pluginMain"),
    agentId: get("agentId"),
    watcherAgent: get("watcherAgent"),
    config: get("config"),
    sessionId: get("sessionId"),
    tabId: get("tabId"),
    worktreeId: get("worktreeId"),
    gatewayUrl: get("gatewayUrl"),
    gatewayToken: get("gatewayToken"),
    selection: flag(argv, "selection"),
  };
}

/** A plugin watcher, with the keys an interrupt sends into its agent. */
interface LoadedWatcher {
  watch: (ctx: unknown) => void | Promise<void>;
  interruptKeys: string;
}

async function loadWatcher(args: Args): Promise<LoadedWatcher> {
  const module = (await import(pathToFileURL(args.pluginMain).href)) as PluginModule;
  const watcher = module.default?.watchers?.find((item) => item.agent === args.watcherAgent);
  if (!watcher) {
    throw new Error(`watcher for agent ${args.watcherAgent} not found in ${args.pluginId}`);
  }
  return { watch: watcher.watch, interruptKeys: interruptKeysFor(watcher) };
}

// fallow-ignore-next-line complexity -- stream-read loop with NDJSON parse + error recovery; refactoring would not reduce essential complexity
async function* outputChunks(
  sdk: PragmaClient,
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const event of attachSessionEvents(sdk, sessionId, signal)) {
    if (signal.aborted) return;
    if (event.type === "output") {
      yield decoder.decode(base64ToBytes(event.dataBase64), { stream: true });
    } else if (event.type === "exit") {
      return;
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function auditSendKeys(args: Args, bytes: number): void {
  process.stderr.write(
    `${JSON.stringify({
      type: "watcher.sendKeys",
      pluginId: args.pluginId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      bytes,
      ts: Date.now(),
    })}\n`,
  );
}

/** Connects once and forwards {@link AgentInterrupt} events until the stream ends. */
async function forwardInterrupts(
  sdk: PragmaClient,
  args: Args,
  sendKeys: (data: string) => Promise<void>,
  signal: AbortSignal,
  interruptKeys: string,
): Promise<void> {
  const connection = await sdk.agents.connect({
    agent: args.agentId,
    tabId: args.tabId,
    worktreeId: args.worktreeId,
    signal,
  });
  for await (const event of connection) {
    if (signal.aborted) return;
    if (event.type === "agentInterrupt") {
      await sendKeys(interruptKeys);
    }
  }
}

/**
 * Subscribes to this tab's agent events and, on an {@link AgentInterrupt}
 * matching this watcher's agent + tab, sends the watcher's interrupt keys
 * (Escape unless it declares others) through the existing sendKeys path. Reconnects on stream end/error and only resolves once `signal` aborts —
 * a transient failure must never tear the watcher down. No per-plugin plumbing:
 * interrupt delivery is a built-in watcher default.
 */
async function deliverInterrupts(
  sdk: PragmaClient,
  args: Args,
  sendKeys: (data: string) => Promise<void>,
  signal: AbortSignal,
  interruptKeys: string,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await forwardInterrupts(sdk, args, sendKeys, signal, interruptKeys);
    } catch {
      // Stream errored: fall through to the reconnect backoff below.
    }
    if (signal.aborted) return;
    // Stream ended or errored without an abort: back off, then reconnect.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function run(args: Args): Promise<void> {
  const sdk = new PragmaClient({ baseUrl: args.gatewayUrl, token: args.gatewayToken });
  const controller = new AbortController();
  const { watch, interruptKeys } = await loadWatcher(args);
  const session = { id: args.sessionId, tabId: args.tabId, worktreeId: args.worktreeId };
  const sendKeys = async (data: string): Promise<void> => {
    const bytes = new TextEncoder().encode(data);
    auditSendKeys(args, bytes.length);
    await sdk.sessions.write(args.sessionId, bytes, { signal: controller.signal });
  };
  const reportMessage = async (
    msg: Omit<AgentMessage, "agent" | "tabId" | "worktreeId">,
  ): Promise<void> => {
    await sdk.agents.reportMessage({
      ...msg,
      agent: args.agentId,
      tabId: args.tabId,
      worktreeId: args.worktreeId,
    });
  };
  const output = outputChunks(sdk, args.sessionId, controller.signal);
  await Promise.race([
    deliverInterrupts(sdk, args, sendKeys, controller.signal, interruptKeys),
    Promise.resolve(
      watch({
        sdk,
        agentId: args.agentId,
        config: JSON.parse(args.config) as unknown,
        session,
        selection: parseLaunchSelection(args.selection),
        output,
        sendKeys,
        reportMessage,
        signal: controller.signal,
      }),
    ),
    waitForExit(sdk, args.sessionId, controller.signal),
  ]);
  controller.abort();
}

async function main(): Promise<number> {
  try {
    await run(parseArgs(process.argv.slice(2)));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ type: "watcher.error", error: message })}\n`);
    return 1;
  }
}

process.exitCode = await main();
