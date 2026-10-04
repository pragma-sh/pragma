/**
 * `pragma-github` host-side sidecar.
 *
 * The token never reaches a client: `pragma-server` holds it, exports it into
 * this process's environment, and proxies the result. Every command reads it
 * from the environment rather than an argument, so it cannot end up in a
 * process listing.
 */
import { readStdin } from "@pragma/sidecar-kit";

import { viewerLogin } from "./index.ts";
import { findPullRequest, listBranches, publishPullRequest } from "./pull-requests.ts";

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

/** Looks up the pull request for a head branch, open, merged, or closed. */
async function runPullRequest(args: string[]): Promise<number> {
  const pullRequest = await findPullRequest(tokenFromEnvironment(), {
    owner: required(args, "owner"),
    repo: required(args, "repo"),
    head: required(args, "head"),
    baseUrl: flag(args, "base-url"),
  });
  emit({ type: "result", pullRequest });
  return 0;
}

/** Lists the repository's branches, for the base-branch picker. */
async function runBranches(args: string[]): Promise<number> {
  const branches = await listBranches(tokenFromEnvironment(), {
    owner: required(args, "owner"),
    repo: required(args, "repo"),
    baseUrl: flag(args, "base-url"),
  });
  emit({ type: "result", branches });
  return 0;
}

/**
 * Creates a pull request. The title and body arrive on stdin rather than as
 * arguments: a PR body is long, multi-line, and not something to put in a
 * process listing.
 */
async function runCreatePullRequest(args: string[]): Promise<number> {
  const input = JSON.parse(await readStdin()) as {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  };
  const pullRequest = await publishPullRequest(tokenFromEnvironment(), {
    ...input,
    baseUrl: flag(args, "base-url"),
  });
  emit({ type: "result", pullRequest });
  return 0;
}

function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  status: runStatus,
  viewer: runViewer,
  "pull-request": runPullRequest,
  branches: runBranches,
  "create-pull-request": runCreatePullRequest,
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
