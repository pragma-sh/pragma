/**
 * `pragma-ai` — the Bun-compiled Tauri sidecar that runs the Node-only pi SDK
 * out of process for the Rust app. Each invocation is one operation.
 *
 * Protocol: newline-delimited JSON ("NDJSON") on stdout. One-shot commands print
 * a single `result`/`error` line. The interactive `login` command streams
 * `auth` / `device-code` / `progress` / `prompt` / `select` events and reads
 * NDJSON responses from stdin to drive the OAuth flow.
 *
 * Commands:
 *   methods                       → { type: "methods", methods }
 *   status                        → { type: "status", available, signedIn }
 *   set-key --provider <id>       (key on stdin)  → status
 *   logout --provider <id>        → status
 *   commit-message --cwd <path>   (diff on stdin) → { type: "result", message } | error
 *   commit-plan --cwd <path>      (JSON context on stdin) → { type: "result", commits } | error
 *   pull-request --cwd <path>     (JSON context on stdin) → { type: "result", title, body } | error
 *   inline-edit --cwd <path>      (JSON context on stdin) → { type: "result", summary, edits } | error
 *   ask --cwd <path>              (JSON context on stdin) → streams delta/reset; → { type: "result", text } | error
 *   login --provider <id>         streaming OAuth; → { type: "result", provider } | error
 */
import { readStdinLines } from "@pragma/sidecar-kit";

import {
  type AiAuthMethod,
  createAuthStorage,
  createModelRegistry,
  generateCommitMessage,
  generateCommitPlan,
  generateInlineEdit,
  generatePullRequestDraft,
  isAiAvailable,
  listAuthMethods,
  loginOAuth,
  NoCommittedChangesError,
  NoInstructionError,
  NoQuestionError,
  NoWorktreeChangesError,
  logout,
  NoStagedChangesError,
  setApiKey,
  signedInProviders,
  streamAskAi,
  type AskAiWorktreeRef,
} from "./index.ts";

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

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** A line-buffered stdin reader for the interactive login flow. */
class StdinLines {
  private waiters: Array<(line: string) => void> = [];
  private pending: string[] = [];

  constructor() {
    readStdinLines((line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.pending.push(line);
  }

  next(): Promise<string> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function statusEvent(
  registry: ReturnType<typeof createModelRegistry>,
  authStorage: ReturnType<typeof createAuthStorage>,
): void {
  emit({
    type: "status",
    available: isAiAvailable(registry),
    signedIn: signedInProviders(authStorage),
  });
}

async function runLogin(provider: string): Promise<void> {
  const authStorage = createAuthStorage();
  const stdin = new StdinLines();

  const ask = async (request: Record<string, unknown>): Promise<string> => {
    emit(request);
    const line = await stdin.next();
    const parsed = JSON.parse(line) as { value?: string; cancelled?: boolean };
    if (parsed.cancelled) throw new Error("Login cancelled.");
    return parsed.value ?? "";
  };

  await loginOAuth(authStorage, provider, {
    onAuth: (info) => emit({ type: "auth", url: info.url, instructions: info.instructions }),
    onDeviceCode: (info) =>
      emit({
        type: "device-code",
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        intervalSeconds: info.intervalSeconds,
        expiresInSeconds: info.expiresInSeconds,
      }),
    onProgress: (message) => emit({ type: "progress", message }),
    onPrompt: (prompt) =>
      ask({
        type: "prompt",
        message: prompt.message,
        placeholder: prompt.placeholder,
        allowEmpty: prompt.allowEmpty,
      }),
    onManualCodeInput: () => ask({ type: "manual-code", message: "Paste the authorization code" }),
    onSelect: async (prompt) => {
      const value = await ask({ type: "select", message: prompt.message, options: prompt.options });
      return value || undefined;
    },
  });

  emit({ type: "result", provider });
}

async function runMethods(): Promise<number> {
  const methods: AiAuthMethod[] = listAuthMethods();
  emit({ type: "methods", methods });
  return 0;
}

async function runStatus(): Promise<number> {
  const authStorage = createAuthStorage();
  statusEvent(createModelRegistry(authStorage), authStorage);
  return 0;
}

async function runSetKey(args: string[]): Promise<number> {
  const provider = flag(args, "provider");
  if (!provider) throw new Error("--provider is required");
  const key = (await readAllStdin()).trim();
  if (!key) throw new Error("No API key provided on stdin");
  const authStorage = createAuthStorage();
  setApiKey(authStorage, provider, key);
  authStorage.reload();
  statusEvent(createModelRegistry(authStorage), authStorage);
  return 0;
}

async function runLogout(args: string[]): Promise<number> {
  const provider = flag(args, "provider");
  if (!provider) throw new Error("--provider is required");
  const authStorage = createAuthStorage();
  logout(authStorage, provider);
  statusEvent(createModelRegistry(authStorage), authStorage);
  return 0;
}

type AuthSession = {
  cwd: string;
  authStorage: ReturnType<typeof createAuthStorage>;
  registry: ReturnType<typeof createModelRegistry>;
};

/** Shared cwd + auth + registry setup for one-shot stdin commands. */
async function withAuthSession(args: string[]): Promise<AuthSession> {
  const cwd = flag(args, "cwd") ?? process.cwd();
  const authStorage = createAuthStorage();
  const registry = createModelRegistry(authStorage);
  return { cwd, authStorage, registry };
}

/** Parse stdin JSON, then attach the shared auth session. */
async function withStdinContext<T>(
  args: string[],
  parse: (raw: string) => T,
): Promise<T & AuthSession> {
  const session = await withAuthSession(args);
  return { ...parse(await readAllStdin()), ...session };
}

async function runCommitMessage(args: string[]): Promise<number> {
  const session = await withAuthSession(args);
  const message = await generateCommitMessage({
    stagedDiff: await readAllStdin(),
    ...session,
  });
  emit({ type: "result", message });
  return 0;
}

function parseCommitPlanContext(raw: string): {
  allowedPaths: string[];
  status: string;
  diffStat: string;
  worktreeDiff: string;
} {
  const {
    allowedPaths = [],
    status = "",
    diffStat = "",
    worktreeDiff = "",
  } = JSON.parse(raw) as {
    allowedPaths?: string[];
    status?: string;
    diffStat?: string;
    worktreeDiff?: string;
  };
  return { allowedPaths, status, diffStat, worktreeDiff };
}

async function runCommitPlan(args: string[]): Promise<number> {
  const context = await withStdinContext(args, parseCommitPlanContext);
  const plan = await generateCommitPlan(context);
  emit({ type: "result", commits: plan.commits });
  return 0;
}

function parsePullRequestContext(raw: string): {
  gitLog: string;
  diffStat: string;
  committedDiff: string;
} {
  const context = JSON.parse(raw) as {
    gitLog?: string;
    diffStat?: string;
    committedDiff?: string;
  };
  return {
    gitLog: context.gitLog ?? "",
    diffStat: context.diffStat ?? "",
    committedDiff: context.committedDiff ?? "",
  };
}

async function runPullRequest(args: string[]): Promise<number> {
  const context = await withStdinContext(args, parsePullRequestContext);
  const draft = await generatePullRequestDraft(context);
  emit({ type: "result", title: draft.title, body: draft.body });
  return 0;
}

// fallow-ignore-next-line complexity -- JSON field defaults for the NDJSON stdin contract; each arm is a missing-key fallback.
function parseInlineEditContext(raw: string): {
  filePath: string;
  instruction: string;
  doc: string;
  startLine: number;
  endLine: number;
} {
  const context = JSON.parse(raw) as {
    filePath?: string;
    instruction?: string;
    doc?: string;
    startLine?: number;
    endLine?: number;
  };
  const startLine = context.startLine ?? 1;
  return {
    filePath: context.filePath ?? "",
    instruction: context.instruction ?? "",
    doc: context.doc ?? "",
    startLine,
    endLine: context.endLine ?? startLine,
  };
}

async function runInlineEdit(args: string[]): Promise<number> {
  const context = await withStdinContext(args, parseInlineEditContext);
  const draft = await generateInlineEdit(context);
  emit({ type: "result", summary: draft.summary, edits: draft.edits });
  return 0;
}

function parseAskContext(raw: string): {
  question: string;
  worktrees: AskAiWorktreeRef[];
} {
  const context = JSON.parse(raw) as {
    question?: string;
    worktrees?: AskAiWorktreeRef[];
  };
  return {
    question: context.question ?? "",
    worktrees: Array.isArray(context.worktrees) ? context.worktrees : [],
  };
}

async function runAsk(args: string[]): Promise<number> {
  const context = await withStdinContext(args, parseAskContext);
  const text = await streamAskAi({
    ...context,
    onDelta: (delta) => emit({ type: "delta", text: delta }),
    onReset: () => emit({ type: "reset" }),
  });
  emit({ type: "result", text });
  return 0;
}

async function runLoginCommand(args: string[]): Promise<number> {
  const provider = flag(args, "provider");
  if (!provider) throw new Error("--provider is required");
  await runLogin(provider);
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  methods: runMethods,
  status: runStatus,
  "set-key": runSetKey,
  logout: runLogout,
  "commit-message": runCommitMessage,
  "commit-plan": runCommitPlan,
  "pull-request": runPullRequest,
  "inline-edit": runInlineEdit,
  ask: runAsk,
  login: runLoginCommand,
};

async function main(): Promise<number> {
  const [, , command, ...args] = process.argv;
  try {
    return await dispatchCommand(command, args);
  } catch (error) {
    emitCommandError(error);
    return 1;
  }
}

async function dispatchCommand(command: string | undefined, args: string[]): Promise<number> {
  const handler = command ? COMMANDS[command] : undefined;
  if (handler) {
    return await handler(args);
  }
  emitError(`Unknown command: ${command ?? "(none)"}`, "usage");
  return 2;
}

const TYPED_ERROR_CODES: ReadonlyArray<[new (...args: never[]) => Error, string]> = [
  [NoStagedChangesError, "no-staged"],
  [NoCommittedChangesError, "no-committed"],
  [NoWorktreeChangesError, "no-changes"],
  [NoInstructionError, "no-instruction"],
  [NoQuestionError, "no-question"],
];

/** Maps a thrown error to its NDJSON `code` for the "nothing to do" cases. */
function emitCommandError(error: unknown): void {
  for (const [ErrorClass, code] of TYPED_ERROR_CODES) {
    if (error instanceof ErrorClass) {
      emitError(error, code);
      return;
    }
  }
  emitError(error);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    emitError(error);
    process.exit(1);
  },
);
