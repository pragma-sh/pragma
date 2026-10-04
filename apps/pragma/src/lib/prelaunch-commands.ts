import { toast } from "sonner";

import { constants, type Tab } from "@pragma-sh/constants";
import { formatPromptWithContext, splitPromptContext } from "@pragma-sh/plugin/catalog";

import {
  cancelWorktreeCommands,
  runWorktreeCommands,
  type WorktreeCommandResult,
} from "@/lib/tauri";

/** How long "run first" commands may run before the user is offered a skip. */
export const PRELAUNCH_SLOW_WARNING_MS = 30_000;
/**
 * Most output kept per command stream. The tail is kept — a failing build or
 * test run reports what went wrong last — so a noisy command cannot flood the
 * agent's prompt.
 */
export const PRELAUNCH_OUTPUT_LIMIT = constants.agents.prelaunchOutputLimit;

/**
 * Starts an inline shell command in an agent prompt (`!!`). In markdown the
 * command is this prefix followed by a code span — `` !!`bun run test` `` —
 * so it can sit mid-sentence.
 */
export const SHELL_COMMAND_PREFIX = constants.agents.prelaunchCommandPrefix;

// The splitting and formatting below have a Rust twin the host uses for
// fanout attempts (`pragma-core/src/prelaunch.rs`); keep the two identical.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BACKTICK = "`";

/** One `` !!`command` `` found in markdown source. */
export interface ShellCommandMatch {
  /** Index just past the closing backticks. */
  end: number;
  /** The code span alone (`` `command` ``), what the agent reads in its place. */
  span: string;
  /** The command, code-span padding stripped. */
  command: string;
}

/**
 * Reads a `` !!`command` `` starting exactly at `at`: the prefix, a run of
 * backticks, and the next run of the same length on the same text. `null`
 * when there is none, e.g. an unclosed span.
 */
export function matchShellCommand(source: string, at: number): ShellCommandMatch | null {
  if (!source.startsWith(SHELL_COMMAND_PREFIX + BACKTICK, at)) return null;
  const open = at + SHELL_COMMAND_PREFIX.length;
  const contentStart = runEnd(source, open);
  const ticks = contentStart - open;
  for (let search = contentStart; ; ) {
    const close = source.indexOf(BACKTICK, search);
    if (close === -1) return null;
    const closeEnd = runEnd(source, close);
    if (closeEnd - close === ticks) {
      return {
        end: closeEnd,
        span: source.slice(open, closeEnd),
        command: stripSpanPadding(source.slice(contentStart, close)).trim(),
      };
    }
    search = closeEnd;
  }
}

function runEnd(source: string, from: number): number {
  let end = from;
  while (source[end] === BACKTICK) end += 1;
  return end;
}

/** CommonMark: one leading and trailing space is padding when both are present. */
function stripSpanPadding(content: string): string {
  return content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()
    ? content.slice(1, -1)
    : content;
}

/**
 * Pulls the `` !!`command` `` chips (the prompt editor's command boxes) out of
 * a prompt. Each is replaced by its plain code span, so the sentence still
 * reads naturally for the agent, and the non-empty commands come back in
 * order. Fenced code blocks are left alone.
 */
export function splitPromptCommands(markdown: string): { prompt: string; commands: string[] } {
  const lines: string[] = [];
  const commands: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    lines.push(fence === null ? replaceCommands(line, commands) : line);
  }
  return { prompt: lines.join("\n").trim(), commands };
}

/** Swaps each command chip on one line for its code span, collecting the commands. */
function replaceCommands(line: string, commands: string[]): string {
  let out = "";
  let at = 0;
  for (let next = line.indexOf(SHELL_COMMAND_PREFIX, at); next !== -1; ) {
    const match = matchShellCommand(line, next);
    if (!match) {
      next = line.indexOf(SHELL_COMMAND_PREFIX, next + 1);
      continue;
    }
    out += line.slice(at, next);
    if (match.command) {
      commands.push(match.command);
      out += match.span;
    }
    at = match.end;
    next = line.indexOf(SHELL_COMMAND_PREFIX, at);
  }
  return out + line.slice(at);
}

/**
 * Appends the "run first" commands and their output to a prompt, one
 * `<command-output>` element per command, so the agent can tell the user's
 * request from what the commands printed.
 */
export function formatPromptWithCommandOutput(
  prompt: string,
  results: readonly WorktreeCommandResult[],
): string {
  if (results.length === 0) return prompt;
  const intro =
    "Before this session started, I ran these commands in the worktree. Their output follows.";
  const blocks = results.map(formatCommandBlock);
  return [prompt.trimEnd(), intro, ...blocks].filter(Boolean).join("\n\n");
}

function formatCommandBlock(result: WorktreeCommandResult): string {
  const attributes = [`command="${escapeAttribute(result.command)}"`];
  if (result.status !== null) attributes.push(`exit-code="${result.status}"`);
  if (result.cancelled) attributes.push('skipped="true"');
  // Integer tenths, rounded half up, so the host's Rust formatter agrees exactly.
  const tenths = Math.floor((result.durationMs + 50) / 100);
  attributes.push(`duration="${Math.floor(tenths / 10)}.${tenths % 10}s"`);
  return `<command-output ${attributes.join(" ")}>\n${commandBody(result)}\n</command-output>`;
}

function commandBody(result: WorktreeCommandResult): string {
  const sections: string[] = [];
  const stdout = tail(result.stdout.trimEnd());
  const stderr = tail(result.stderr.trimEnd());
  if (stdout) sections.push(stdout);
  if (stderr) sections.push(`[stderr]\n${stderr}`);
  if (result.cancelled) {
    sections.push(
      result.durationMs > 0
        ? "(skipped by the user before it finished; output above is partial)"
        : "(skipped by the user; never ran)",
    );
  }
  return sections.length > 0 ? sections.join("\n") : "(no output)";
}

function tail(text: string): string {
  if (text.length <= PRELAUNCH_OUTPUT_LIMIT) return text;
  const dropped = text.length - PRELAUNCH_OUTPUT_LIMIT;
  return `[… ${dropped} earlier characters truncated]\n${text.slice(-PRELAUNCH_OUTPUT_LIMIT)}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Outcome of {@link runPrelaunchCommands}. */
interface PrelaunchRun {
  results: WorktreeCommandResult[];
  /** The slow-run warning was shown, i.e. the user may have moved on. */
  warned: boolean;
}

/**
 * Runs `work` — something that executes pre-launch commands under `runId` on
 * the host that owns `worktreeId` — and, after
 * {@link PRELAUNCH_SLOW_WARNING_MS}, shows a warning whose **Skip** cancels
 * that run: the running command is killed and the rest are skipped, so `work`
 * resolves with whatever was captured. `warned` reports whether it showed.
 */
export async function withSlowCommandWarning<T>(
  worktreeId: string,
  commandCount: number,
  startingLabel: string,
  work: (runId: string) => Promise<T>,
): Promise<{ value: T; warned: boolean }> {
  const runId = crypto.randomUUID();
  let warningId: string | number | null = null;
  const timer = window.setTimeout(() => {
    warningId = toast.warning(`Still running commands before starting ${startingLabel}`, {
      description: `${commandCount === 1 ? "The command has" : "The commands have"} been running for over ${PRELAUNCH_SLOW_WARNING_MS / 1000}s. Skip to start with the output so far.`,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Skip",
        onClick: () => {
          void cancelWorktreeCommands(worktreeId, runId).catch((cause: unknown) => {
            toast.error(`Could not skip: ${errorMessage(cause)}`);
          });
        },
      },
    });
  }, PRELAUNCH_SLOW_WARNING_MS);
  try {
    const value = await work(runId);
    return { value, warned: warningId !== null };
  } finally {
    window.clearTimeout(timer);
    if (warningId !== null) toast.dismiss(warningId);
  }
}

/** Runs the commands headlessly in the worktree, with the slow-run warning. */
async function runPrelaunchCommands(
  worktreeId: string,
  commands: string[],
  agentLabel: string,
): Promise<PrelaunchRun> {
  const { value: results, warned } = await withSlowCommandWarning(
    worktreeId,
    commands.length,
    agentLabel,
    (runId) => runWorktreeCommands(worktreeId, commands, runId),
  );
  return { results, warned };
}

/**
 * Runs a stored launch prompt's `!!` commands in `worktreeId` and returns the
 * prompt to send: the text without them, then their output, then any `@`
 * context blocks. Commands are looked for only in the user's text, never in
 * attached context. A prompt without commands comes back unchanged.
 */
export async function resolvePromptCommands(
  worktreeId: string,
  stored: string,
  agentLabel: string,
): Promise<PrelaunchPrompt> {
  const { prompt: text, blocks } = splitPromptContext(stored);
  const { prompt, commands } = splitPromptCommands(text);
  if (commands.length === 0) return { prompt: stored, warned: false };
  const { results, warned } = await runPrelaunchCommands(worktreeId, commands, agentLabel);
  const withOutput = formatPromptWithCommandOutput(prompt, results);
  return { prompt: formatPromptWithContext(withOutput, blocks), warned };
}

/** Outcome of {@link resolvePromptCommands}. */
export interface PrelaunchPrompt {
  prompt: string;
  /** The slow-run warning was shown, i.e. the user may have moved on. */
  warned: boolean;
}

/** Announces a session launched in the background after a slow run, with a way to open it. */
export function announceBackgroundSession(agentLabel: string, open: () => void): void {
  toast.success(`${agentLabel} started`, { action: { label: "Open", onClick: open } });
}

/** What {@link startSessionAfterCommands} needs from the workspace. */
export interface DeferredSessionLaunch {
  worktreeId: string;
  agentLabel: string;
  commands: string[];
  prompt: string;
  /** Starts the session; `focus: false` launches it without switching to it. */
  start: (prompt: string | undefined, focus: boolean) => Promise<Tab | null>;
  /** Brings a background-launched session's tab into view. */
  open: (tab: Tab) => void;
}

/**
 * Runs the "run first" commands, then starts the agent with their output
 * appended to the prompt. A run slow enough to be warned about launches in
 * the background (the user may be elsewhere by then) and announces the new
 * session with an **Open** action instead of stealing focus.
 */
export async function startSessionAfterCommands(launch: DeferredSessionLaunch): Promise<void> {
  try {
    const { results, warned } = await runPrelaunchCommands(
      launch.worktreeId,
      launch.commands,
      launch.agentLabel,
    );
    const prompt = formatPromptWithCommandOutput(launch.prompt, results);
    const tab = await launch.start(prompt.trim() ? prompt : undefined, !warned);
    if (tab && warned) announceBackgroundSession(launch.agentLabel, () => launch.open(tab));
  } catch (cause) {
    toast.error(`Could not start ${launch.agentLabel}: ${errorMessage(cause)}`);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
