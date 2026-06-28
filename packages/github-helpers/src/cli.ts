/** `pragma-github` host-side sidecar. */
import { viewerLogin } from "./index.ts";

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitError(error: unknown, code = "error"): void {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "error", code, error: message });
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function tokenFromEnvironment(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.PRAGMA_GITHUB_TOKEN;
  if (!token) {
    throw new Error("missing GITHUB_TOKEN or PRAGMA_GITHUB_TOKEN");
  }
  return token;
}

async function runStatus(): Promise<number> {
  emit({
    type: "status",
    available: Boolean(process.env.GITHUB_TOKEN ?? process.env.PRAGMA_GITHUB_TOKEN),
  });
  return 0;
}

async function runViewer(args: string[]): Promise<number> {
  const login = await viewerLogin(tokenFromEnvironment(), flag(args, "base-url"));
  emit({ type: "result", login });
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  status: runStatus,
  viewer: runViewer,
};

async function main(): Promise<number> {
  const [, , command, ...args] = process.argv;
  try {
    return await dispatchCommand(command, args);
  } catch (error) {
    emitError(error);
    return 1;
  }
}

async function dispatchCommand(command: string | undefined, args: string[]): Promise<number> {
  const handler = command ? COMMANDS[command] : undefined;
  if (handler) {
    return await handler(args);
  }
  throw new Error(`unknown command: ${command ?? "<none>"}`);
}

process.exitCode = await main();
