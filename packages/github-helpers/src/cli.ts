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

async function main(): Promise<number> {
  const [, , command, ...args] = process.argv;
  try {
    switch (command) {
      case "status": {
        emit({
          type: "status",
          available: Boolean(process.env.GITHUB_TOKEN ?? process.env.PRAGMA_GITHUB_TOKEN),
        });
        return 0;
      }
      case "viewer": {
        const login = await viewerLogin(tokenFromEnvironment(), flag(args, "base-url"));
        emit({ type: "result", login });
        return 0;
      }
      default:
        throw new Error(`unknown command: ${command ?? "<none>"}`);
    }
  } catch (error) {
    emitError(error);
    return 1;
  }
}

process.exitCode = await main();
