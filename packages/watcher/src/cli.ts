/** `pragma-watch` host-side sidecar for plugin watcher instances. */
import { pathToFileURL } from "node:url";

import { PragmaClient, type AgentMessage, type SessionEvent } from "@pragma/sdk";

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
}

interface PluginModule {
  default?: {
    watchers?: Array<{
      agent: string;
      watch: (ctx: unknown) => void | Promise<void>;
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
  };
}

async function loadWatcher(args: Args): Promise<(ctx: unknown) => void | Promise<void>> {
  const module = (await import(pathToFileURL(args.pluginMain).href)) as PluginModule;
  const watcher = module.default?.watchers?.find((item) => item.agent === args.watcherAgent);
  if (!watcher) {
    throw new Error(`watcher for agent ${args.watcherAgent} not found in ${args.pluginId}`);
  }
  return watcher.watch;
}

async function* outputChunks(
  sdk: PragmaClient,
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const event of sdk.sessions.attach(sessionId, { signal })) {
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

async function run(args: Args): Promise<void> {
  const sdk = new PragmaClient({ baseUrl: args.gatewayUrl, token: args.gatewayToken });
  const controller = new AbortController();
  const watch = await loadWatcher(args);
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
    Promise.resolve(
      watch({
        sdk,
        config: JSON.parse(args.config) as unknown,
        session,
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

async function waitForExit(
  sdk: PragmaClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of sdk.sessions.attach(sessionId, { signal })) {
    if ((event as SessionEvent).type === "exit") return;
  }
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
