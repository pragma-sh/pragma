// Host-side watcher for the built-in opencode agent, loaded by the `pragma-watch`
// sidecar (see `apps/pragma/src-tauri/src/plugins.rs`). opencode exposes no
// decision-returning plugin hook on the current binary, so remote command
// approval and question answers go the watcher route: the in-process opencode
// plugin reports a `command`/`question` attention (which raises the Pragma toast
// / mobile answer UI), and this watcher writes the matching keystrokes into the
// live terminal.
//
// Type-only imports keep this module free of the `@pragma/plugin` runtime barrel
// so the sidecar bundle stays a lean node module.
import type { AgentStreamEvent } from "@pragma/sdk";

import type { WatcherContext, WatcherDefinition } from "@pragma/plugin";

/** Per-plugin config controlling which keystrokes answer opencode's prompt. */
export interface OpencodeWatcherConfig {
  /**
   * Bytes written to accept a permission prompt. Default `\r` (Enter — opencode's
   * three-option prompt has "Allow" selected first, so Enter approves).
   */
  approveKeys?: string;
  /**
   * Bytes written to reject a prompt. Default two Right-arrow presses then Enter
   * (`\x1b[C\x1b[C\r`) — moves the selection to opencode's third ("Reject")
   * option and confirms it.
   */
  denyKeys?: string;
  /**
   * Bytes written after an interjection's text to submit it. Default `\r`
   * (Enter). Set to `""` to type the text without submitting.
   */
  submitKeys?: string;
}

const DEFAULT_APPROVE_KEYS = "\r";
const RIGHT_ARROW = "\x1b[C";
const DOWN_ARROW = "\x1b[B";
const DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
const DEFAULT_SUBMIT_KEYS = "\r";
/** Escape rejects OpenCode's question prompt when not editing free-text. */
const QUESTION_REJECT_KEYS = "\x1b";
/** OpenCode's question TUI binds digits 1–9 to select+submit a single answer. */
const QUESTION_DIGIT_MAX = 9;
/** Lets OpenCode mount its custom-answer editor before typing into it. */
const QUESTION_OTHER_INPUT_DELAY_MS = 150;
/** Lets paste-aware TUIs commit interjected text before receiving Enter. */
const CLAUDE_INTERJECT_SUBMIT_DELAY_MS = 200;

/** Backoff before re-subscribing after the agent event stream drops. */
const RESUBSCRIBE_DELAY_MS = 500;

/**
 * Builds a built-in-agent watcher. `handleDecisions` is true for opencode (whose
 * permission / question prompts have no decision-returning hook and so must be
 * answered via keystrokes); it is false for agents (Claude Code, Cursor) whose
 * approvals go through a blocking `await-decision` hook, leaving the watcher
 * responsible only for interjections.
 */
function createBuiltinWatcher(
  agent: string,
  handleDecisions: boolean,
  interjectSubmitDelayMs = 0,
): WatcherDefinition<OpencodeWatcherConfig> {
  return {
    agent,
    async watch(ctx: WatcherContext<OpencodeWatcherConfig>): Promise<void> {
      const keys = resolveKeys(ctx.config);
      const seenRequestIds = new Set<string>();
      /** Options from the latest `question` attention, keyed by requestId. */
      const questionOptionsByRequestId = new Map<string, string[]>();

      while (!ctx.signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one live connection at a time; reconnect only after the previous stream ends.
          await consumeControlEvents(
            ctx,
            keys,
            handleDecisions,
            interjectSubmitDelayMs,
            seenRequestIds,
            questionOptionsByRequestId,
          );
        } catch {
          // Stream error (not an abort): fall through to re-connect below.
        }
        if (ctx.signal.aborted) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- backoff before the next reconnect is intentionally serial.
        await delay(RESUBSCRIBE_DELAY_MS, ctx.signal);
      }
    },
  };
}

/** Answers opencode permission/question prompts and applies interjections via keystrokes. */
export const opencodeApprovalWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("opencode", true);

/** Applies interjections to Claude Code; approvals go through its blocking hook. */
export const claudeCodeInterjectWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("claude-code", false, CLAUDE_INTERJECT_SUBMIT_DELAY_MS);

/** Applies interjections to Cursor Agent; approvals go through its blocking hook. */
export const cursorInterjectWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("cursor", false);

interface ControlKeys {
  approveKeys: string;
  denyKeys: string;
  submitKeys: string;
}

/** Resolves the effective keystrokes from config, applying opencode's defaults. */
function resolveKeys(config: OpencodeWatcherConfig | undefined): ControlKeys {
  const c = config ?? {};
  return {
    approveKeys: c.approveKeys ?? DEFAULT_APPROVE_KEYS,
    denyKeys: c.denyKeys ?? DEFAULT_DENY_KEYS,
    submitKeys: c.submitKeys ?? DEFAULT_SUBMIT_KEYS,
  };
}

/**
 * Drains one agent connection scoped to this watcher's agent + tab, applying
 * command/question verdicts (when `handleDecisions`) and interjections to the
 * live terminal. The connection is already filtered to this agent + tab, so no
 * per-event scope check is needed.
 */
async function consumeControlEvents(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  keys: ControlKeys,
  handleDecisions: boolean,
  interjectSubmitDelayMs: number,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
): Promise<void> {
  const connection = await ctx.sdk.agents.connect({
    agent: ctx.agentId,
    tabId: ctx.session.tabId,
    worktreeId: ctx.session.worktreeId,
    signal: ctx.signal,
  });
  for await (const event of connection) {
    if (ctx.signal.aborted) {
      return;
    }
    await handleControlEvent(
      ctx,
      keys,
      handleDecisions,
      interjectSubmitDelayMs,
      seenRequestIds,
      questionOptionsByRequestId,
      event,
    );
  }
}

/** Applies one stream event: a deduped command/question verdict or an interjection. */
async function handleControlEvent(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  keys: ControlKeys,
  handleDecisions: boolean,
  interjectSubmitDelayMs: number,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
  event: AgentStreamEvent,
): Promise<void> {
  // Remember question choices from attention reports so an AgentAnswer can be
  // turned into the matching TUI digit / free-text keystroke sequence.
  if (event.type === "agent" && handleDecisions) {
    rememberQuestionOptions(questionOptionsByRequestId, event);
    return;
  }
  if (handleDecisions && (await handleDecision(ctx, keys, seenRequestIds, event))) {
    return;
  }
  if (
    handleDecisions &&
    (await handleAnswer(ctx, seenRequestIds, questionOptionsByRequestId, event))
  ) {
    return;
  }
  if (event.type === "agentInput") {
    await handleInterjection(ctx, keys.submitKeys, interjectSubmitDelayMs, event.input.text);
  }
}

async function handleDecision(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  keys: ControlKeys,
  seenRequestIds: Set<string>,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentDecision") return false;
  if (seenRequestIds.has(event.decision.requestId)) return true;
  seenRequestIds.add(event.decision.requestId);
  await writeKeys(ctx, event.decision.approved ? keys.approveKeys : keys.denyKeys);
  return true;
}

async function handleAnswer(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentAnswer") return false;
  const { answer } = event;
  if (seenRequestIds.has(answer.requestId)) return true;
  seenRequestIds.add(answer.requestId);
  const options = questionOptionsByRequestId.get(answer.requestId) ?? [];
  questionOptionsByRequestId.delete(answer.requestId);
  const reply = answer.answer?.trim() ?? null;
  if (!answer.dismissed && reply && !options.includes(reply)) {
    await writeFreeTextAnswer(ctx, options.length, reply);
    return true;
  }
  const strokes = questionAnswerKeys({ dismissed: answer.dismissed, reply, options });
  if (strokes) await writeKeys(ctx, strokes);
  return true;
}

async function writeFreeTextAnswer(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  optionCount: number,
  reply: string,
): Promise<void> {
  // OpenCode reserves digit shortcuts for listed choices. Navigate to its virtual Other row.
  await writeKeys(ctx, openOtherEditorKeys(optionCount));
  await delay(QUESTION_OTHER_INPUT_DELAY_MS, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, `${reply}\r`);
}

async function handleInterjection(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  submitKeys: string,
  submitDelayMs: number,
  text: string,
): Promise<void> {
  if (submitDelayMs <= 0 || !submitKeys) {
    await writeKeys(ctx, `${text}${submitKeys}`);
    return;
  }
  await writeKeys(ctx, text);
  await delay(submitDelayMs, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, submitKeys);
}

/**
 * Caches option labels for a live `question` attention so a later answer can
 * pick the matching OpenCode TUI digit. Drops the cache when attention clears.
 */
function rememberQuestionOptions(
  cache: Map<string, string[]>,
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): void {
  if (
    event.status === "attention" &&
    event.attentionKind === "question" &&
    typeof event.requestId === "string" &&
    event.requestId.length > 0
  ) {
    const options = (event.options ?? [])
      .map((option) => option.label)
      .filter((option) => option.trim() !== "");
    cache.set(event.requestId, options);
  }
  // Orphaned entries (cleared/aborted without an AgentAnswer) are tiny and are
  // overwritten the next time the same requestId is reused; the answer handler
  // deletes the entry on a successful reply.
}

/**
 * Builds the OpenCode question-TUI keystroke sequence for one remote answer.
 *
 * Single-select questions bind digits `1`–`9` to select+submit immediately.
 * "Type your own answer" is the virtual option after the last label. It needs
 * arrow navigation plus Enter to open its editor, then text + Enter to submit.
 * Dismiss maps to Escape. Returns `null` when there is nothing to write.
 */
export function questionAnswerKeys(input: {
  dismissed: boolean;
  reply: string | null;
  options: string[];
}): string | null {
  if (input.dismissed || input.reply === null) {
    return QUESTION_REJECT_KEYS;
  }
  const reply = input.reply.trim();
  if (!reply) {
    return QUESTION_REJECT_KEYS;
  }
  const options = input.options;
  const matchIndex = options.findIndex((option) => option === reply);
  if (matchIndex >= 0) {
    return selectOptionKeys(matchIndex, options.length);
  }
  // Free-text / "Other": open the custom-answer editor, type, submit.
  return `${openOtherEditorKeys(options.length)}${reply}\r`;
}

/** Opens OpenCode's virtual custom-answer editor. */
function openOtherEditorKeys(optionCount: number): string {
  return `${DOWN_ARROW.repeat(optionCount)}\r`;
}

/**
 * Keys that highlight option `index` (0-based) and activate it. Prefer digits
 * 1–9 (OpenCode's fast path); fall back to Down arrows + Enter past digit 9.
 */
function selectOptionKeys(index: number, optionCount: number): string {
  const total = optionCount + 1; // options + "Type your own answer"
  if (index < QUESTION_DIGIT_MAX && index < total) {
    return String(index + 1);
  }
  return `${DOWN_ARROW.repeat(index)}\r`;
}

/** Writes keystrokes, swallowing transient failures so the watcher survives. */
async function writeKeys(ctx: WatcherContext<OpencodeWatcherConfig>, data: string): Promise<void> {
  try {
    await ctx.sendKeys(data);
  } catch {
    // A transient write failure must not tear down the watcher; a later
    // verdict or interjection for this session still gets a chance to apply.
  }
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  });
}

/**
 * Default export shape the `pragma-watch` sidecar loads (`default.watchers`).
 * This is the shared built-in-agent watcher bundle: the sidecar selects the
 * entry whose `agent` matches the launched agent, so opencode, Claude Code, and
 * Cursor all resolve from this one module.
 */
const pragmaWatcher: { watchers: WatcherDefinition<OpencodeWatcherConfig>[] } = {
  watchers: [opencodeApprovalWatcher, claudeCodeInterjectWatcher, cursorInterjectWatcher],
};

export default pragmaWatcher;
